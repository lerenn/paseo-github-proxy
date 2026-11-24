import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { resolveApp, WEBHOOK_PATH, type AppEntry, type WebhooksConfig } from "../shared/config";
import { EventLog } from "./eventstats";
import { eventOwner, parseEvent, type Parsed } from "./events";

export const MAX_BODY_BYTES = 1_048_576;
const DEDUPE_MAX = 2000;
const DEDUPE_MS = 60 * 60_000;

export interface WebhookCounters {
  accepted: number;
  badSignature: number;
  badOwner: number;
  ignored: number;
  duplicate: number;
}

export interface WebhookStatus {
  enabled: boolean;
  listening: boolean;
  port: number;
  bind: string;
  path: string;
  /** A start error (port in use, bad address), empty otherwise. */
  error: string;
  lastDeliveryAt: number | null;
  counters: WebhookCounters;
  /** How many GitHub Apps have a webhook secret. Deliveries signed by no one are refused. */
  appsWithSecret: number;
}

export interface Reply {
  status: number;
  text: string;
}

export interface ReceiverDeps {
  /** The Apps that have a webhook secret. */
  secrets: () => { app: AppEntry; secret: string }[];
  /** Every App, to decide who serves an owner. */
  apps: () => AppEntry[];
  /** Called for each accepted event; errors are swallowed and logged. Returns how many agents were woken: above zero counts the event as delivered to a subscriber. */
  onEvent: (parsed: Parsed) => number | void | Promise<number | void>;
  /** Per-minute outcomes, for the Overview. */
  events?: EventLog;
  clock?: () => number;
  log?: (message: string) => void;
}

/** `sha256=<hex>` over the raw body. Constant-time comparison; false for any malformed header. */
export function signatureMatches(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec((header ?? "").trim());
  if (!m) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(m[1]!, "hex"));
}

/**
 * The delivery logic, without sockets: verifies the signature against each App's secret (the App that matches signed it),
 * checks the owner is one that App serves, drops repeated deliveries, then hands the parsed event on.
 * Refusals say nothing about why. Nothing from the payload or any secret is logged.
 */
export class WebhookReceiver {
  readonly counters: WebhookCounters = { accepted: 0, badSignature: 0, badOwner: 0, ignored: 0, duplicate: 0 };
  lastDeliveryAt: number | null = null;
  readonly events: EventLog;
  private seen = new Map<string, number>();
  private readonly clock: () => number;

  constructor(private readonly deps: ReceiverDeps) {
    this.clock = deps.clock ?? Date.now;
    this.events = deps.events ?? new EventLog(this.clock);
  }

  private remember(delivery: string): boolean {
    const now = this.clock();
    for (const [id, at] of this.seen) {
      if (now - at > DEDUPE_MS || this.seen.size > DEDUPE_MAX) this.seen.delete(id);
      else break; // insertion order is time order
    }
    if (this.seen.has(delivery)) return false;
    this.seen.set(delivery, now);
    return true;
  }

  async handle(req: { method: string; path: string; headers: Record<string, string | undefined>; body: Buffer }): Promise<Reply> {
    const url = req.path.split("?")[0];
    if (req.method === "GET" && url === "/healthz") return { status: 200, text: "ok" };
    if (url !== WEBHOOK_PATH) return { status: 404, text: "not found" };
    if (req.method !== "POST") return { status: 405, text: "method not allowed" };
    this.lastDeliveryAt = this.clock();

    // The App that signed it. Every secret is tried, so the time taken does not tell which one matched.
    const signature = req.headers["x-hub-signature-256"];
    let signer: AppEntry | null = null;
    for (const { app, secret } of this.deps.secrets()) if (signatureMatches(secret, req.body, signature) && !signer) signer = app;
    if (!signer) {
      this.counters.badSignature++;
      this.events.record("badSignature");
      return { status: 401, text: "unauthorized" };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      return { status: 400, text: "bad request" };
    }
    const event = req.headers["x-github-event"] ?? "";
    if (event === "ping") {
      this.counters.ignored++;
      this.events.record("ignored");
      return { status: 200, text: "pong" };
    }

    const owner = eventOwner(payload);
    if (!owner || resolveApp(this.deps.apps(), owner)?.id !== signer.id) {
      this.counters.badOwner++;
      this.events.record("badOwner");
      return { status: 403, text: "forbidden" };
    }

    const delivery = req.headers["x-github-delivery"] ?? "";
    if (delivery && !this.remember(delivery)) {
      this.counters.duplicate++;
      this.events.record("duplicate");
      return { status: 200, text: "duplicate" };
    }

    const parsed = parseEvent(event, payload);
    if (!parsed) {
      this.counters.ignored++;
      this.events.record("ignored");
      return { status: 200, text: "ignored" };
    }
    this.counters.accepted++;
    let woken = 0;
    try {
      woken = (await this.deps.onEvent(parsed)) || 0;
    } catch (error) {
      this.deps.log?.(`handling a ${event} event failed: ${(error as Error).message}`);
    }
    this.events.record(woken > 0 ? "delivered" : "ignored");
    return { status: 200, text: "ok" };
  }
}

/** The HTTP listener around a receiver: started only when enabled, only POST /webhook and GET /healthz. */
export class WebhookServer {
  private server: http.Server | null = null;
  private error = "";
  private current: WebhooksConfig = { enabled: false, port: 8787, bind: "0.0.0.0" };

  constructor(
    private readonly receiver: WebhookReceiver,
    private readonly appsWithSecret: () => number,
    private readonly log: (message: string) => void = () => undefined,
    private readonly maxBody = MAX_BODY_BYTES,
  ) {}

  /** Starts, restarts or stops the listener to match the config. Resolves once it listens or failed. */
  async apply(config: WebhooksConfig): Promise<void> {
    const same = this.server && this.current.enabled === config.enabled && this.current.port === config.port && this.current.bind === config.bind;
    this.current = config;
    if (same) return;
    await this.stop();
    this.error = "";
    if (!config.enabled) return;
    await new Promise<void>((resolve) => {
      const server = http.createServer((req, res) => void this.serve(req, res));
      server.requestTimeout = 10_000;
      server.headersTimeout = 10_000;
      server.on("error", (error: Error) => {
        this.error = error.message;
        this.log(`webhook listener could not start: ${error.message}`);
        if (this.server === server) this.server = null;
        resolve();
      });
      server.listen(config.port, config.bind, () => {
        this.server = server;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  /** The port actually bound (useful when the configured port is 0 in tests). */
  address(): number | null {
    const a = this.server?.address();
    return a && typeof a === "object" ? a.port : null;
  }

  /** Outcomes of the deliveries, for the Overview. */
  eventStats() {
    return { enabled: this.current.enabled, stats: this.receiver.events.stats() };
  }

  status(): WebhookStatus {
    return {
      enabled: this.current.enabled,
      listening: this.server?.listening ?? false,
      port: this.current.port,
      bind: this.current.bind,
      path: WEBHOOK_PATH,
      error: this.error,
      lastDeliveryAt: this.receiver.lastDeliveryAt,
      counters: { ...this.receiver.counters },
      appsWithSecret: this.appsWithSecret(),
    };
  }

  private async serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (r: Reply) => {
      res.writeHead(r.status, { "content-type": "text/plain", "content-length": Buffer.byteLength(r.text), connection: "close" });
      res.end(r.text);
    };
    try {
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > this.maxBody) {
        reply({ status: 413, text: "too large" });
        req.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > this.maxBody) {
          tooBig = true;
          break;
        }
        chunks.push(chunk as Buffer);
      }
      if (tooBig) {
        reply({ status: 413, text: "too large" });
        req.destroy();
        return;
      }
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
      reply(await this.receiver.handle({ method: req.method ?? "", path: req.url ?? "", headers, body: Buffer.concat(chunks) }));
    } catch {
      if (!res.headersSent) reply({ status: 400, text: "bad request" });
    }
  }
}
