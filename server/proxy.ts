import type { Action } from "../shared/actions";
import type { Config, SourceId } from "../shared/config";
import type { ActivityStatus, Overview } from "../shared/state";
import type { ActivityLog } from "./activity";
import { AuthError, chooseSources, type FetchFn, type TokenSource } from "./auth";
import { cacheKey, isFresh, type CacheEntry, type ResponseCache } from "./cache";
import { classifyGraphql, classifyRest, normalizePath, type Classified } from "./classify";
import { evaluate, ownerAllowed, ownerDenial, type Decision } from "./policy";
import { detectLimit, limitMessage, parseRateLimit, resourceOf, type RateLimitTracker } from "./ratelimit";

export interface CallContext {
  agentId: string;
  agentTitle: string;
  tool: string;
}

export type ProxyErrorKind = "denied" | "rate_limited" | "auth" | "http" | "invalid";

/** An error whose message is written for the agent. */
export class ProxyError extends Error {
  constructor(
    readonly kind: ProxyErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export interface ProxyResponse {
  status: number;
  data: unknown;
  /** How it was served. */
  served: "upstream" | "cache" | "revalidated" | "stale";
  link: string | null;
  source: SourceId | null;
}

export interface ProxyDeps {
  config: () => Config;
  sources: Record<SourceId, TokenSource>;
  fetch: FetchFn;
  cache: ResponseCache;
  tracker: RateLimitTracker;
  activity: ActivityLog;
  clock?: () => number;
  apiBase?: string;
}

interface Prepared {
  method: string;
  url: string;
  body?: string;
  classified: Classified;
  resource: string;
  cacheable: boolean;
}

export interface DryRun {
  allowed: boolean;
  message: string;
  repo: string;
  actions: Action[];
  rule: string | null;
}

/** The GitHub front door: owner allowlist, policy, cache with ETags, rate limits, auth source selection, activity log. */
export class GithubProxy {
  private readonly clock: () => number;
  private readonly base: string;

  constructor(private readonly deps: ProxyDeps) {
    this.clock = deps.clock ?? Date.now;
    this.base = deps.apiBase ?? "https://api.github.com";
  }

  // ---- public entry points -------------------------------------------------------------------

  async rest(ctx: CallContext, input: { method: string; path: string; query?: Record<string, string | number | undefined>; body?: unknown; actions?: Action[] }): Promise<ProxyResponse> {
    const { path, query: pathQuery } = normalizePath(input.path);
    const params = new URLSearchParams(pathQuery);
    for (const [k, v] of Object.entries(input.query ?? {})) if (v !== undefined && v !== "") params.set(k, String(v));
    const qs = params.toString();
    const method = input.method.toUpperCase();
    const classified = classifyRest(method, qs ? `${path}?${qs}` : path, input.body);
    // A curated tool states what it does; only github_api is classified from the path.
    if (input.actions) classified.actions = input.actions;
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    return this.run(ctx, { method, url: `${this.base}${path}${qs ? `?${qs}` : ""}`, ...(body !== undefined ? { body } : {}), classified, resource: resourceOf(path), cacheable: method === "GET" });
  }

  async graphql(ctx: CallContext, input: { query: string; variables?: Record<string, unknown>; repo?: string }): Promise<ProxyResponse> {
    const classified = classifyGraphql(input.query, input.repo ?? "", input.variables);
    if (classified.info.operation === "subscription") {
      return this.refuse(ctx, classified, "Denied: GraphQL subscriptions are not supported.");
    }
    const body = JSON.stringify({ query: input.query, ...(input.variables ? { variables: input.variables } : {}) });
    return this.run(ctx, { method: "POST", url: `${this.base}/graphql`, body, classified, resource: "graphql", cacheable: classified.info.operation === "query" });
  }

  /** Same checks as a real call, nothing sent to GitHub: for the "test this call" box. */
  dryRun(input: { kind: "rest" | "graphql"; method?: string; path?: string; query?: string; repo?: string; body?: unknown }): DryRun {
    const classified =
      input.kind === "graphql" ? classifyGraphql(input.query ?? "", input.repo ?? "", undefined) : classifyRest(input.method ?? "GET", input.path ?? "/", input.body);
    const verdict = this.judge(classified);
    return { allowed: verdict.allowed, message: verdict.allowed ? "Allowed." : verdict.message, repo: classified.repo, actions: classified.actions, rule: verdict.rule };
  }

  /** The decision for a curated tool: it knows its repo and actions without parsing a path. */
  judgeAction(repo: string, actions: Action[]): Decision | { allowed: false; message: string; action: null; rule: null } {
    return this.judgeParts(repo, repo ? [repo.split("/")[0]!] : [], actions);
  }

  /**
   * A cached GET used by the settings UI (owner and repository pickers), not by agents: it is read-only, goes through the
   * active source, cache and rate-limit tracking, and is not logged as agent activity. Callers apply the owner allowlist and policy to what they return.
   */
  async lookup(path: string, query: Record<string, string | number> = {}): Promise<unknown> {
    const params = new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]));
    const qs = params.toString();
    const p: Prepared = { method: "GET", url: `${this.base}${path}${qs ? `?${qs}` : ""}`, classified: classifyRest("GET", path), resource: resourceOf(path), cacheable: true };
    return (await this.fetchThrough(p)).data;
  }

  // ---- internals -----------------------------------------------------------------------------

  private judge(classified: Classified): { allowed: boolean; message: string; rule: string | null } {
    const verdict = this.judgeParts(classified.repo, classified.owners, classified.actions, classified.unscoped);
    return { allowed: verdict.allowed, message: verdict.message, rule: verdict.rule ? `rule #${verdict.rule.index + 1}` : null };
  }

  private judgeParts(repo: string, owners: string[], actions: Action[], unscoped?: string): Decision | { allowed: false; message: string; action: null; rule: null } {
    const config = this.deps.config();
    const wildcard = config.allowedOwners.map((o) => o.trim()).includes("*");
    if (unscoped && !wildcard) return { allowed: false, message: `Denied: ${unscoped}. Do not retry this call as is.`, action: null, rule: null };
    for (const owner of owners) {
      if (!ownerAllowed(config.allowedOwners, owner)) return { allowed: false, message: ownerDenial(config.allowedOwners, owner), action: null, rule: null };
    }
    if (owners.length === 0 && !wildcard && config.allowedOwners.length === 0) {
      return { allowed: false, message: ownerDenial(config.allowedOwners, ""), action: null, rule: null };
    }
    const target = repo || (owners[0] ? `${owners[0]}/` : "");
    return evaluate(config.policy, target, actions);
  }

  private record(ctx: CallContext, c: Classified, status: ActivityStatus, extra: { httpStatus?: number | null; source?: SourceId | null; detail?: string; started: number }): void {
    this.deps.activity.add({
      agentId: ctx.agentId,
      agentTitle: ctx.agentTitle,
      tool: ctx.tool,
      repo: c.repo || c.owners.join(", "),
      action: c.actions.join("+"),
      status,
      httpStatus: extra.httpStatus ?? null,
      source: extra.source ?? null,
      detail: extra.detail ?? "",
      ms: Math.max(0, this.clock() - extra.started),
    });
  }

  private refuse(ctx: CallContext, c: Classified, message: string): never {
    this.record(ctx, c, "denied", { detail: message, started: this.clock() });
    throw new ProxyError("denied", message);
  }

  private async run(ctx: CallContext, p: Prepared): Promise<ProxyResponse> {
    const started = this.clock();
    const verdict = this.judge(p.classified);
    if (!verdict.allowed) {
      this.record(ctx, p.classified, "denied", { detail: verdict.message, started });
      throw new ProxyError("denied", verdict.message);
    }
    try {
      const response = await this.fetchThrough(p);
      const status: ActivityStatus = response.served === "cache" ? "cached" : response.served === "revalidated" ? "revalidated" : "allowed";
      this.record(ctx, p.classified, response.served === "stale" ? "cached" : status, {
        httpStatus: response.status,
        source: response.source,
        detail: response.served === "stale" ? "served stale: rate limited" : "",
        started,
      });
      return response;
    } catch (error) {
      const e = error instanceof ProxyError ? error : new ProxyError("http", (error as Error).message);
      this.record(ctx, p.classified, e.kind === "rate_limited" ? "rate_limited" : "error", { httpStatus: e.status, detail: e.message, started });
      throw e;
    }
  }

  private async fetchThrough(p: Prepared): Promise<ProxyResponse> {
    const config = this.deps.config();
    const key = cacheKey(p.method, p.url, p.body);
    const entry = p.cacheable ? this.deps.cache.get(key) : undefined;
    const now = this.clock();
    if (entry && isFresh(entry, config.cacheTtlSeconds, now)) return this.fromEntry(entry, "cache", null);

    const choice = chooseSources({
      active: config.activeSource,
      fallback: config.fallbackOnRateLimit,
      configured: { gh: this.deps.sources.gh.configured() as boolean, app: this.deps.sources.app.configured() as boolean },
      tracker: this.deps.tracker,
      resource: p.resource,
    });
    if (choice.order.length === 0) {
      if (entry) return this.fromEntry(entry, "stale", null);
      const b = choice.blocked;
      if (b?.reason === "rate_limited" && b.until) throw new ProxyError("rate_limited", limitMessage(b.source, b.until, now), 429);
      throw new ProxyError("auth", `The ${config.activeSource === "gh" ? "gh CLI" : "GitHub App"} source is not configured. Ask the user to set it up in GitHub Proxy → Auth.`, 401);
    }

    let lastLimit: { source: SourceId; until: number } | null = null;
    for (const source of choice.order) {
      try {
        const out = await this.send(source, p, entry, key);
        if (out.kind === "limited") {
          lastLimit = { source, until: out.until };
          continue;
        }
        return out.response;
      } catch (error) {
        if (error instanceof AuthError) {
          if (choice.order.length > 1 && source !== choice.order[choice.order.length - 1]) continue;
          throw new ProxyError("auth", error.message, 401);
        }
        throw error;
      }
    }
    if (entry) return this.fromEntry(entry, "stale", lastLimit?.source ?? null);
    throw new ProxyError("rate_limited", limitMessage(lastLimit!.source, lastLimit!.until, this.clock()), 429);
  }

  private fromEntry(entry: CacheEntry, served: ProxyResponse["served"], source: SourceId | null): ProxyResponse {
    return { status: entry.status, data: parseBody(entry.body, entry.contentType), served, link: entry.link, source };
  }

  private async send(source: SourceId, p: Prepared, entry: CacheEntry | undefined, key: string): Promise<{ kind: "ok"; response: ProxyResponse } | { kind: "limited"; until: number }> {
    const tokenSource = this.deps.sources[source];
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await tokenSource.token();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "paseo-github-proxy",
      };
      if (p.body !== undefined) headers["Content-Type"] = "application/json";
      if (entry?.etag) headers["If-None-Match"] = entry.etag;
      const res = await this.deps.fetch(p.url, { method: p.method, headers, ...(p.body !== undefined ? { body: p.body } : {}) });
      const now = this.clock();
      const text = res.status === 304 ? "" : await res.text();
      this.deps.tracker.record(source, parseRateLimit(res.headers, now));

      if (res.status === 401 && attempt === 0) {
        tokenSource.invalidate();
        continue;
      }
      const verdict = detectLimit(res.status, res.headers, text, now);
      if (verdict.limited) {
        this.deps.tracker.block(source, verdict.until);
        return { kind: "limited", until: verdict.until };
      }
      if (res.status === 304 && entry) {
        this.deps.cache.touch(key, now);
        return { kind: "ok", response: this.fromEntry(entry, "revalidated", source) };
      }
      if (res.status >= 400) throw new ProxyError("http", httpMessage(res.status, text), res.status);

      const contentType = res.headers.get("content-type") ?? "application/json";
      if (p.cacheable) {
        this.deps.cache.set({ key, etag: res.headers.get("etag"), status: res.status, body: text, contentType, link: res.headers.get("link"), fetchedAt: now });
      } else if (p.method !== "GET" && p.classified.repo) {
        // A write changes what the reads of that repo will say.
        this.deps.cache.invalidate(`/repos/${p.classified.repo}`);
      }
      return { kind: "ok", response: { status: res.status, data: parseBody(text, contentType), served: "upstream", link: res.headers.get("link"), source } };
    }
    throw new ProxyError("auth", "GitHub rejected the credentials (HTTP 401). Ask the user to check GitHub Proxy → Auth.", 401);
  }

  overview(): Overview {
    const config = this.deps.config();
    const now = this.clock();
    const warnings: string[] = [];
    const sources = (["gh", "app"] as const).map((source) => {
      const limits = this.deps.tracker.limits(source);
      const blockedUntil = this.deps.tracker.blockedUntil(source);
      for (const l of limits) {
        if (l.limit > 0 && l.remaining / l.limit <= 0.1 && l.resetAt > now) warnings.push(`${source === "gh" ? "gh CLI" : "GitHub App"}: ${l.resource} is nearly exhausted (${l.remaining}/${l.limit} left).`);
      }
      return { source, configured: this.deps.sources[source].configured() as boolean, active: config.activeSource === source, blockedUntil, limits };
    });
    if (config.allowedOwners.length === 0) warnings.push("No allowed owner yet: every call is refused until you add one in Auth.");
    return { now, sources, stats: this.deps.activity.stats(this.deps.cache.size), allowedOwnersEmpty: config.allowedOwners.length === 0, warnings };
  }
}

function parseBody(body: string, contentType: string): unknown {
  if (!body) return null;
  if (/json/i.test(contentType)) {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return body;
}

function httpMessage(status: number, body: string): string {
  let detail = body.slice(0, 600);
  try {
    const parsed = JSON.parse(body) as { message?: string; errors?: unknown };
    detail = parsed.message ?? detail;
    if (parsed.errors) detail += ` ${JSON.stringify(parsed.errors).slice(0, 300)}`;
  } catch {
    /* keep the raw text */
  }
  const hint = status === 404 ? " (not found, or the credentials cannot see it)" : status === 403 ? " (forbidden: the credentials lack this permission)" : "";
  return `GitHub answered HTTP ${status}${hint}: ${detail}`;
}
