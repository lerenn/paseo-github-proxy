import WebSocket from "ws";
import type { ForwarderView } from "../shared/subscriptions";
import { GitHubError, type GitHubClient } from "./github";

export const WEBHOOK_EVENTS = ["check_run", "check_suite", "status", "pull_request", "pull_request_review", "pull_request_review_comment", "issue_comment", "workflow_run"];

/** A decoded delivery from GitHub's webhook forwarder. */
export interface Delivery {
  event: string;
  payload: any;
}

export interface Socket {
  onMessage(cb: (raw: string) => void): void;
  onClose(cb: (reason: string) => void): void;
  send(text: string): void;
  close(): void;
}

export type Connect = (wsUrl: string, token: string) => Promise<Socket>;

/** `ws` client. GitHub wants the raw token in `Authorization`, without a scheme. */
export const connectWs: Connect = (wsUrl, token) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Authorization: token } });
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`websocket refused: HTTP ${res.statusCode}`)));
    ws.once("open", () => {
      ws.off("error", reject);
      resolve({
        onMessage: (cb) => ws.on("message", (d) => cb(d.toString())),
        onClose: (cb) => {
          ws.on("close", (code) => cb(`closed (${code})`));
          ws.on("error", (e) => cb(`error: ${e.message}`));
        },
        send: (t) => ws.send(t),
        close: () => ws.close(),
      });
    });
  });

interface Entry {
  repo: string;
  owner: string;
  state: ForwarderView["state"];
  detail: string | null;
  hookUrl: string | null;
  socket: Socket | null;
  retry: ReturnType<typeof setTimeout> | null;
  failures: number;
  stopped: boolean;
}

export interface ForwarderOptions {
  client: GitHubClient;
  token: (owner: string) => string | null;
  onDelivery: (repo: string, d: Delivery) => void;
  connect?: Connect;
  /** Called whenever a forwarder changes state, so polling cadence can follow. */
  onState?: () => void;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** How long to leave a repository alone after GitHub refuses a forwarder (no admin, or one already exists). */
  unavailableMs?: number;
}

/**
 * One webhook forwarder per repository, the same mechanism as `gh webhook forward`: create an
 * inactive "cli" hook, dial the websocket it returns, activate the hook, then acknowledge each
 * delivery. Needs admin on the repository; where that fails the repository is left to polling.
 */
export class Forwarders {
  private readonly entries = new Map<string, Entry>();
  private readonly o: Required<Omit<ForwarderOptions, "client" | "token" | "onDelivery" | "onState">> & ForwarderOptions;

  constructor(options: ForwarderOptions) {
    this.o = { connect: connectWs, retryBaseMs: 5000, retryMaxMs: 300_000, unavailableMs: 30 * 60_000, ...options };
  }

  views(): ForwarderView[] {
    return [...this.entries.values()].map((e) => ({ repo: e.repo, state: e.state, detail: e.detail }));
  }

  healthy(repo: string): boolean {
    return this.entries.get(repo.toLowerCase())?.state === "healthy";
  }

  ensure(repo: string) {
    const key = repo.toLowerCase();
    if (this.entries.has(key)) return;
    const entry: Entry = { repo: key, owner: key.split("/")[0], state: "connecting", detail: null, hookUrl: null, socket: null, retry: null, failures: 0, stopped: false };
    this.entries.set(key, entry);
    void this.connect(entry);
  }

  async release(repo: string) {
    const entry = this.entries.get(repo.toLowerCase());
    if (!entry) return;
    this.entries.delete(entry.repo);
    await this.teardown(entry);
  }

  async stop() {
    await Promise.all([...this.entries.keys()].map((r) => this.release(r)));
  }

  private async teardown(entry: Entry) {
    entry.stopped = true;
    if (entry.retry) clearTimeout(entry.retry);
    entry.socket?.close();
    entry.socket = null;
    if (entry.hookUrl) {
      // Best effort: GitHub also drops dev hooks whose socket is gone.
      await this.o.client.rest({ owner: entry.owner, method: "DELETE", path: entry.hookUrl, priority: "background" }).catch(() => {});
    }
  }

  private setState(entry: Entry, state: Entry["state"], detail: string | null) {
    entry.state = state;
    entry.detail = detail;
    this.o.onState?.();
  }

  private async connect(entry: Entry) {
    if (entry.stopped) return;
    const token = this.o.token(entry.owner);
    if (!token) return this.setState(entry, "unavailable", `no token for ${entry.owner}`);
    try {
      const hook = (
        await this.o.client.rest<{ ws_url: string; url: string }>({
          owner: entry.owner,
          method: "POST",
          path: `/repos/${entry.repo}/hooks`,
          body: { name: "cli", events: WEBHOOK_EVENTS, active: false, config: { content_type: "json", insecure_ssl: "0" } },
          priority: "background",
        })
      ).data;
      entry.hookUrl = new URL(hook.url).pathname;
      const socket = await this.o.connect(hook.ws_url, token);
      if (entry.stopped) return socket.close();
      entry.socket = socket;
      socket.onMessage((raw) => this.deliver(entry, socket, raw));
      socket.onClose((reason) => {
        if (entry.socket !== socket) return;
        entry.socket = null;
        this.retry(entry, reason);
      });
      await this.o.client.rest({ owner: entry.owner, method: "PATCH", path: entry.hookUrl, body: { active: true }, priority: "background" });
      entry.failures = 0;
      this.setState(entry, "healthy", null);
    } catch (err) {
      entry.socket?.close();
      entry.socket = null;
      const refused = err instanceof GitHubError && [403, 404, 422].includes(err.status);
      if (refused) {
        const why = err.status === 422 ? "a forwarder already exists for this repository" : "the token needs admin rights on the repository";
        this.setState(entry, "unavailable", `${why}; polling only`);
        this.schedule(entry, this.o.unavailableMs);
      } else {
        this.retry(entry, (err as Error).message);
      }
    }
  }

  private retry(entry: Entry, reason: string) {
    if (entry.stopped) return;
    entry.failures++;
    this.setState(entry, "connecting", `reconnecting after: ${reason}`);
    this.schedule(entry, Math.min(this.o.retryMaxMs, this.o.retryBaseMs * 2 ** (entry.failures - 1)));
  }

  private schedule(entry: Entry, ms: number) {
    if (entry.retry) clearTimeout(entry.retry);
    entry.retry = setTimeout(() => {
      entry.retry = null;
      // The old hook is useless once its socket is gone; start clean.
      const old = entry.hookUrl;
      entry.hookUrl = null;
      const cleanup = old ? this.o.client.rest({ owner: entry.owner, method: "DELETE", path: old, priority: "background" }).catch(() => {}) : Promise.resolve();
      void cleanup.then(() => this.connect(entry));
    }, ms);
  }

  private deliver(entry: Entry, socket: Socket, raw: string) {
    try {
      const msg = JSON.parse(raw) as { Header?: Record<string, string[]>; Body?: string };
      const event = msg.Header?.["X-Github-Event"]?.[0] ?? msg.Header?.["X-GitHub-Event"]?.[0] ?? "";
      const payload = msg.Body ? JSON.parse(Buffer.from(msg.Body, "base64").toString("utf8")) : {};
      // Acknowledge first, as the forwarder expects a response per delivery.
      socket.send(JSON.stringify({ Status: 200, Header: {}, Body: Buffer.from("OK").toString("base64") }));
      this.o.onDelivery(entry.repo, { event, payload });
    } catch (err) {
      console.error(`github-proxy: bad webhook delivery for ${entry.repo}: ${(err as Error).message}`);
    }
  }
}

/** Pull request numbers and commit SHAs a delivery may concern. */
export function targetsOf(d: Delivery): { numbers: number[]; shas: string[] } {
  const p = d.payload ?? {};
  const numbers = new Set<number>();
  const shas = new Set<string>();
  if (typeof p.number === "number" && d.event === "pull_request") numbers.add(p.number);
  if (p.pull_request?.number) numbers.add(p.pull_request.number);
  if (d.event === "issue_comment" && p.issue?.pull_request && p.issue.number) numbers.add(p.issue.number);
  for (const pr of [...(p.check_run?.pull_requests ?? []), ...(p.check_suite?.pull_requests ?? []), ...(p.workflow_run?.pull_requests ?? [])]) {
    if (pr?.number) numbers.add(pr.number);
  }
  for (const sha of [p.check_run?.head_sha, p.check_suite?.head_sha, p.workflow_run?.head_sha, d.event === "status" ? p.sha : undefined]) {
    if (typeof sha === "string") shas.add(sha);
  }
  return { numbers: [...numbers], shas: [...shas] };
}
