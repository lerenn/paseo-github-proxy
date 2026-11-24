import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { isLoopbackAddress, type ClientApiConfig } from "../shared/config";
import { AuthError } from "./auth";
import { repoFromGitPath, type GitAccess, type GitCredentials } from "./gitcred";
import { ProxyError, type CallContext, type GithubProxy } from "./proxy";

export const CLIENT_MAX_BODY_BYTES = 5_242_880;
/** What `GH_PROXY_TOKEN` is set to when no token is configured: the old `gh` shim refuses an empty one. The server ignores it. */
export const NO_TOKEN_PLACEHOLDER = "none";

export interface ClientCounters {
  requests: number;
  denied: number;
  unauthorized: number;
  gitCredentials: number;
}

export interface ClientApiStatus {
  enabled: boolean;
  listening: boolean;
  port: number;
  bind: string;
  loopback: boolean;
  error: string;
  tokenSet: boolean;
  url: string;
  helperFound: boolean;
  helperError: string;
  lastRequestAt: number | null;
  counters: ClientCounters;
}

export interface ClientRequest {
  method: string;
  /** Path and query string, as sent. */
  url: string;
  headers: Record<string, string | undefined>;
  body: Buffer;
  /** The peer address of the socket, when known. */
  remoteAddress?: string;
}

export interface ClientReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ClientApiDeps {
  proxy: Pick<GithubProxy, "rest" | "graphql">;
  git: Pick<GitCredentials, "token">;
  /** The bearer token, "" when none is set. */
  token: () => string;
  clock?: () => number;
  log?: (message: string) => void;
}

const json = (status: number, value: unknown, extra: Record<string, string> = {}): ClientReply => ({ status, headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(value) });
const sha = (text: string) => createHash("sha256").update(text).digest();
const headerHost = (host: string | undefined): string => (host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");

/**
 * The client API without sockets: `gh` shim routes (`/v1/rest/...`, `/v1/graphql`), `/healthz` and the git credential
 * endpoints. Every REST and GraphQL call goes through the same pipeline as the MCP tools (`GithubProxy`).
 * It serves nothing else: the webhook path lives on another listener and is not here.
 */
export class ClientApi {
  readonly counters: ClientCounters = { requests: 0, denied: 0, unauthorized: 0, gitCredentials: 0 };
  lastRequestAt: number | null = null;
  private readonly clock: () => number;

  constructor(private readonly deps: ClientApiDeps) {
    this.clock = deps.clock ?? Date.now;
  }

  async handle(req: ClientRequest): Promise<ClientReply> {
    const [path = "/", query = ""] = splitUrl(req.url);
    if (req.method === "GET" && path === "/healthz") return json(200, { status: "ok" });
    if (!path.startsWith("/v1/")) return json(404, { error: "route_not_found" });
    this.counters.requests++;
    this.lastRequestAt = this.clock();

    const denied = this.authenticate(req);
    if (denied) {
      this.counters.unauthorized++;
      return denied;
    }
    const ctx = this.context(req);
    try {
      if (path === "/v1/auth/status" && req.method === "GET") return json(200, { name: "paseo-github-proxy" });
      if (path.startsWith("/v1/rest/")) return await this.rest(ctx, req, path.slice("/v1/rest/".length), query);
      if (path === "/v1/graphql") return req.method === "POST" ? await this.graphql(ctx, req) : json(405, { error: "method_not_allowed" });
      if (path === "/v1/git-credential") return req.method === "POST" ? await this.gitCredential(ctx, req) : json(405, { error: "method_not_allowed" });
      if (path === "/v1/git/token") return req.method === "POST" ? await this.gitToken(ctx, req) : json(405, { error: "method_not_allowed" });
      if (path.startsWith("/v1/watch/")) return json(501, { error: "unsupported", message: "Server-sent events are not offered by the plugin. Poll, or use github_subscribe." });
      return json(404, { error: "route_not_found" });
    } catch (error) {
      return this.fail(error);
    }
  }

  /** The token when one is set; otherwise only this machine may call, and a browser page may not. */
  private authenticate(req: ClientRequest): ClientReply | null {
    const token = this.deps.token();
    if (token) {
      const m = /^Bearer\s+(.+)$/i.exec((req.headers.authorization ?? "").trim());
      if (m && timingSafeEqual(sha(m[1]!), sha(token))) return null;
      return json(401, { error: "unauthorized", message: "A bearer token is required (GH_PROXY_TOKEN)." }, { "www-authenticate": "Bearer" });
    }
    const local = req.remoteAddress === undefined || isLoopbackAddress(req.remoteAddress);
    if (!local) return json(403, { error: "forbidden", message: "With no token set, the client API answers this machine only." });
    // DNS rebinding and browsers: without a token the Host must be a loopback name or address, and there is no Origin.
    const host = headerHost(req.headers.host);
    if (req.headers.origin !== undefined || (host && !isLoopbackAddress(host) && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.includes(":"))) {
      return json(403, { error: "forbidden", message: "With no token set, the client API refuses browser and non-local requests." });
    }
    return null;
  }

  private context(req: ClientRequest): CallContext {
    const who = (req.headers["x-paseo-agent"] ?? req.headers["x-proxy-run"] ?? "").slice(0, 80);
    return { agentId: who ? `client:${who}` : "client", agentTitle: who || "gh client", tool: "client_api" };
  }

  private async rest(ctx: CallContext, req: ClientRequest, rest: string, query: string): Promise<ClientReply> {
    const method = req.method.toUpperCase();
    if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method)) return json(405, { error: "method_not_allowed" });
    const path = `/${rest.replace(/^\/+/, "")}`;
    if (path === "/") return json(404, { error: "route_not_found" });
    let body: unknown;
    if (method !== "GET" && req.body.length > 0) {
      try {
        body = JSON.parse(req.body.toString("utf8"));
      } catch {
        return json(400, { error: "bad_request", message: "The body must be JSON." });
      }
    }
    const accept = req.headers.accept;
    const res = await this.deps.proxy.rest({ ...ctx, tool: `client ${method}` }, { method, path: query ? `${path}?${query}` : path, ...(body !== undefined ? { body } : {}), ...(accept && !/^\*\/\*$/.test(accept.trim()) && accept !== "application/vnd.github+json" ? { accept } : {}) });
    const headers: Record<string, string> = { "content-type": res.contentType ?? "application/json", "x-proxy-cache": res.served === "upstream" ? "miss" : res.served === "cache" ? "cache_hit" : res.served };
    if (res.etag) headers.etag = res.etag;
    if (res.link) headers.link = res.link;
    if (method === "GET" && res.etag && req.headers["if-none-match"] === res.etag) return { status: 304, headers, body: "" };
    const text = res.data === null || res.status === 204 ? "" : typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    return { status: res.status, headers, body: text };
  }

  private async graphql(ctx: CallContext, req: ClientRequest): Promise<ClientReply> {
    let payload: { query?: unknown; variables?: unknown };
    try {
      payload = JSON.parse(req.body.toString("utf8")) as typeof payload;
    } catch {
      return json(400, { error: "bad_request", message: "The body must be JSON: {query, variables}." });
    }
    if (typeof payload.query !== "string" || !payload.query.trim()) return json(400, { error: "bad_request", message: "The body needs a query." });
    const variables = payload.variables && typeof payload.variables === "object" ? (payload.variables as Record<string, unknown>) : undefined;
    const repo = (req.headers["x-proxy-repo"] ?? "").trim();
    const res = await this.deps.proxy.graphql({ ...ctx, tool: "client graphql" }, { query: payload.query, ...(variables ? { variables } : {}), ...(repo ? { repo } : {}) });
    return { status: res.status, headers: { "content-type": "application/json", "x-proxy-cache": res.served === "upstream" ? "miss" : "cache_hit" }, body: typeof res.data === "string" ? res.data : JSON.stringify(res.data) };
  }

  /** What git sends a credential helper (`protocol`, `host`, `path`): answers github.com repositories only. */
  private async gitCredential(ctx: CallContext, req: ClientRequest): Promise<ClientReply> {
    let attrs: { protocol?: unknown; host?: unknown; path?: unknown };
    try {
      attrs = JSON.parse(req.body.toString("utf8")) as typeof attrs;
    } catch {
      return json(400, { error: "bad_request", message: "The body must be JSON: {protocol, host, path}." });
    }
    const repo = typeof attrs.path === "string" ? repoFromGitPath(attrs.path) : null;
    if (attrs.protocol !== "https" || String(attrs.host ?? "").toLowerCase() !== "github.com" || !repo) {
      return json(404, { error: "not_served", message: "Only https://github.com/<owner>/<repo> is served (git needs credential.useHttpPath=true)." });
    }
    return this.issue(ctx, repo.owner, repo.name, undefined);
  }

  /** The old proxy's `POST /v1/git/token` {repository, access}. */
  private async gitToken(ctx: CallContext, req: ClientRequest): Promise<ClientReply> {
    let input: { repository?: unknown; access?: unknown };
    try {
      input = JSON.parse(req.body.toString("utf8")) as typeof input;
    } catch {
      return json(400, { error: "bad_request", message: "The body must be JSON: {repository, access}." });
    }
    const repo = typeof input.repository === "string" ? repoFromGitPath(input.repository) : null;
    if (!repo) return json(400, { error: "bad_request", message: "repository must be owner/name." });
    const access: GitAccess | undefined = input.access === "write" ? "write" : input.access === "read" || input.access === undefined || input.access === "" ? "read" : undefined;
    if (!access) return json(400, { error: "bad_request", message: "access is read or write." });
    return this.issue(ctx, repo.owner, repo.name, access);
  }

  private async issue(ctx: CallContext, owner: string, name: string, access: GitAccess | undefined): Promise<ClientReply> {
    this.counters.gitCredentials++;
    const t = await this.deps.git.token({ ...ctx, tool: "git credential" }, owner, name, access);
    return json(200, { username: t.username, password: t.password, token: t.password, expires_at: new Date(t.expiresAt).toISOString(), repository: t.repository, access: t.access }, { "cache-control": "no-store" });
  }

  private fail(error: unknown): ClientReply {
    if (error instanceof ProxyError) {
      switch (error.kind) {
        case "denied":
          this.counters.denied++;
          return json(403, { error: "policy_denied", message: error.message, rule: error.denial?.rule ?? "default policy", action: error.denial?.action ?? null, status: 403 });
        case "rate_limited":
          return json(429, { error: "rate_limited", message: error.message });
        case "auth":
          return json(error.status && error.status >= 500 ? error.status : 503, { error: "upstream_auth", message: error.message });
        case "invalid":
          return json(400, { error: "bad_request", message: error.message });
        case "http": {
          if (error.upstreamBody !== null && error.status) return { status: error.status, headers: { "content-type": "application/json" }, body: isJson(error.upstreamBody) ? error.upstreamBody : JSON.stringify({ message: error.message }) };
          return json(error.status && error.status >= 400 ? error.status : 502, { error: "github_error", message: error.message });
        }
      }
    }
    if (error instanceof AuthError) return json(503, { error: "upstream_auth", message: error.message });
    this.deps.log?.(`client API call failed: ${(error as Error).message}`);
    return json(502, { error: "unknown", message: "The plugin could not complete the call." });
  }
}

function splitUrl(url: string): [string, string] {
  const i = url.indexOf("?");
  return i < 0 ? [url, ""] : [url.slice(0, i), url.slice(i + 1)];
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** The HTTP listener around the client API: started only when enabled; loopback by default; no token means loopback only. */
export class ClientApiServer {
  private server: http.Server | null = null;
  private error = "";
  private current: ClientApiConfig = { enabled: false, port: 8788, bind: "127.0.0.1", injectEnv: true };
  private currentToken = false;

  constructor(
    private readonly api: ClientApi,
    private readonly tokenSet: () => boolean,
    private readonly helper: () => { found: boolean; error: string },
    private readonly log: (message: string) => void = () => undefined,
    private readonly maxBody = CLIENT_MAX_BODY_BYTES,
  ) {}

  /** Starts, restarts or stops the listener to match the config. Resolves once it listens or failed. */
  async apply(config: ClientApiConfig): Promise<void> {
    const tokenSet = this.tokenSet();
    const same = this.server && this.current.enabled === config.enabled && this.current.port === config.port && this.current.bind === config.bind && this.currentToken === tokenSet;
    this.current = config;
    this.currentToken = tokenSet;
    if (same) return;
    await this.stop();
    this.error = "";
    if (!config.enabled) return;
    if (!isLoopbackAddress(config.bind) && !tokenSet) {
      this.error = `Refusing to listen on ${config.bind} without a token: generate one in Auth, or bind 127.0.0.1.`;
      this.log(`client API not started: ${this.error}`);
      return;
    }
    await new Promise<void>((resolve) => {
      const server = http.createServer((req, res) => void this.serve(req, res));
      server.requestTimeout = 5 * 60_000;
      server.headersTimeout = 10_000;
      server.on("error", (error: Error) => {
        this.error = error.message;
        this.log(`client API could not start: ${error.message}`);
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

  /** The port actually bound (the configured port may be 0 in tests). */
  address(): number | null {
    const a = this.server?.address();
    return a && typeof a === "object" ? a.port : null;
  }

  status(): ClientApiStatus {
    const helper = this.helper();
    return {
      enabled: this.current.enabled,
      listening: this.server?.listening ?? false,
      port: this.current.port,
      bind: this.current.bind,
      loopback: isLoopbackAddress(this.current.bind),
      error: this.error,
      tokenSet: this.tokenSet(),
      url: clientApiUrl(this.current),
      helperFound: helper.found,
      helperError: helper.error,
      lastRequestAt: this.api.lastRequestAt,
      counters: { ...this.api.counters },
    };
  }

  private async serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (r: ClientReply) => {
      res.writeHead(r.status, { ...r.headers, "content-length": Buffer.byteLength(r.body), connection: "close" });
      res.end(r.status === 304 ? undefined : r.body);
    };
    try {
      if (Number(req.headers["content-length"] ?? 0) > this.maxBody) {
        reply(json(413, { error: "too_large" }));
        req.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > this.maxBody) {
          reply(json(413, { error: "too_large" }));
          req.destroy();
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
      reply(await this.api.handle({ method: req.method ?? "", url: req.url ?? "/", headers, body: Buffer.concat(chunks), ...(req.socket.remoteAddress ? { remoteAddress: req.socket.remoteAddress } : {}) }));
    } catch {
      if (!res.headersSent) reply(json(400, { error: "bad_request" }));
    }
  }
}

/** The URL an agent on this machine uses: a listen-everywhere address becomes 127.0.0.1. */
export function clientApiUrl(config: Pick<ClientApiConfig, "bind" | "port">): string {
  const host = config.bind === "0.0.0.0" || config.bind === "::" ? "127.0.0.1" : config.bind.includes(":") && !config.bind.startsWith("[") ? `[${config.bind}]` : config.bind;
  return `http://${host}:${config.port}`;
}

const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * The environment added to a new agent session: GH_PROXY_URL (and GH_PROXY_TOKEN), and git configuration through
 * GIT_CONFIG_COUNT / KEY_n / VALUE_n so `git fetch` and `git push` over HTTPS ask the plugin for a scoped token.
 * The helper runs with `nodePath` (the node that runs the daemon), so no PATH is assumed.
 * Entries the session already has (an existing GIT_CONFIG_COUNT) are kept: the new ones are appended after them.
 */
export function clientEnv(input: { config: ClientApiConfig; token: string; helperPath: string | null; nodePath?: string; existing?: Record<string, string> }): Record<string, string> {
  const env: Record<string, string> = { GH_PROXY_URL: clientApiUrl(input.config), GH_PROXY_TOKEN: input.token || NO_TOKEN_PLACEHOLDER };
  if (!input.helperPath) return env;
  const start = Math.max(0, Number.parseInt(input.existing?.GIT_CONFIG_COUNT ?? "0", 10) || 0);
  const entries: [string, string][] = [
    ["credential.https://github.com.helper", ""], // forget the helpers inherited from other config levels: ours answers
    ["credential.https://github.com.helper", `!${shellQuote(input.nodePath ?? "node")} ${shellQuote(input.helperPath)}`],
    ["credential.https://github.com.useHttpPath", "true"],
  ];
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${start + i}`] = key;
    env[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(start + entries.length);
  return env;
}
