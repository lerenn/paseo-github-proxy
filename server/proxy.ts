import type { Action } from "../shared/actions";
import type { Config, SourceId } from "../shared/config";
import type { ActivityStatus, Overview } from "../shared/state";
import type { ActivityLog } from "./activity";
import { appName, appOwners, resolveApp, type AppEntry } from "../shared/config";
import { appKey, type AppDirectory } from "./apps";
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
    /** GitHub's own answer body, for an "http" error: the client API passes it on. */
    readonly upstreamBody: string | null = null,
    /** What denied the call (kind "denied"): the rule ("rule #2", null for the default policy) and the action. */
    readonly denial: { rule: string | null; action: Action | null } | null = null,
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
  etag?: string | null;
  contentType?: string;
  source: SourceId | null;
  /** Label of the GitHub App whose credentials served (or keyed the cached answer of) the call. */
  app: string | null;
}

export interface ProxyDeps {
  config: () => Config;
  /** The gh CLI credential. */
  gh: TokenSource;
  /** The GitHub Apps and their token sources. */
  apps: AppDirectory;
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
  /** The owners the call touches: they decide which GitHub App serves it. */
  owners: string[];
  /** Overrides the Accept header (raw diffs, for example). Part of the cache key. */
  accept?: string;
  /** What a write makes stale: cached reads whose key contains one of these fragments are dropped. */
  invalidates?: string[];
  /** Set by the settings UI to force one App (owner discovery), bypassing the active source. */
  via?: { app: string };
}

/** A credential a call may use: the gh CLI, or the GitHub App that serves the call's owner. */
interface Credential {
  key: string;
  source: SourceId;
  label: string;
  /** The App label, for the activity log. */
  app: string | null;
  token: TokenSource | null;
  /** Why it cannot be used, written for the agent. */
  problem?: string;
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

  async rest(ctx: CallContext, input: { method: string; path: string; query?: Record<string, string | number | undefined>; body?: unknown; actions?: Action[]; accept?: string }): Promise<ProxyResponse> {
    const { path, query: pathQuery } = normalizePath(input.path);
    const params = new URLSearchParams(pathQuery);
    for (const [k, v] of Object.entries(input.query ?? {})) if (v !== undefined && v !== "") params.set(k, String(v));
    const qs = params.toString();
    const method = input.method.toUpperCase();
    const classified = classifyRest(method, qs ? `${path}?${qs}` : path, input.body);
    // A curated tool states what it does; only github_api is classified from the path.
    if (input.actions) classified.actions = input.actions;
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    return this.run(ctx, { method, url: `${this.base}${path}${qs ? `?${qs}` : ""}`, ...(body !== undefined ? { body } : {}), classified, resource: resourceOf(path), cacheable: method === "GET", owners: classified.owners, ...(input.accept ? { accept: input.accept } : {}), invalidates: invalidationOf(classified.repo, path) });
  }

  /**
   * `actions` (and `owner` when there is no repo) are for curated tools, whose document is fixed in code: they state what
   * the call does, and the document is not parsed for scoping. Only `github_api` is classified from the document.
   */
  async graphql(ctx: CallContext, input: { query: string; variables?: Record<string, unknown>; repo?: string; actions?: Action[]; owner?: string }): Promise<ProxyResponse> {
    const classified = classifyGraphql(input.query, input.repo ?? "", input.variables);
    if (input.actions) {
      classified.actions = input.actions;
      if (input.owner) classified.owners = [input.owner.toLowerCase()];
      if (input.owner || input.repo) delete classified.unscoped;
    }
    if (classified.info.operation === "subscription") {
      return this.refuse(ctx, classified, "Denied: GraphQL subscriptions are not supported.");
    }
    const body = JSON.stringify({ query: input.query, ...(input.variables ? { variables: input.variables } : {}) });
    return this.run(ctx, { method: "POST", url: `${this.base}/graphql`, body, classified, resource: "graphql", cacheable: classified.info.operation === "query", owners: classified.owners, invalidates: classified.info.operation === "query" ? [] : [...(classified.repo ? [`/repos/${classified.repo}`] : []), "/graphql"] });
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
   * `via.app` asks one GitHub App (by id) to answer, as installation endpoints are per App.
   */
  async lookup(path: string, query: Record<string, string | number> = {}, via?: { app: string }): Promise<unknown> {
    const params = new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]));
    const qs = params.toString();
    const p: Prepared = { method: "GET", url: `${this.base}${path}${qs ? `?${qs}` : ""}`, classified: classifyRest("GET", path), resource: resourceOf(path), cacheable: true, owners: [], ...(via ? { via } : {}) };
    return (await this.fetchThrough(p)).data;
  }

  // ---- internals -----------------------------------------------------------------------------

  private judge(classified: Classified): { allowed: boolean; message: string; rule: string | null; action: Action | null } {
    const verdict = this.judgeParts(classified.repo, classified.owners, classified.actions, classified.unscoped);
    return { allowed: verdict.allowed, message: verdict.message, rule: verdict.rule ? `rule #${verdict.rule.index + 1}` : null, action: verdict.action };
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

  private record(ctx: CallContext, c: Classified, status: ActivityStatus, extra: { httpStatus?: number | null; source?: SourceId | null; app?: string | null; detail?: string; started: number }): void {
    this.deps.activity.add({
      agentId: ctx.agentId,
      agentTitle: ctx.agentTitle,
      tool: ctx.tool,
      repo: c.repo || c.owners.join(", "),
      action: c.actions.join("+"),
      status,
      httpStatus: extra.httpStatus ?? null,
      source: extra.source ?? null,
      app: extra.app ?? null,
      detail: extra.detail ?? "",
      ms: Math.max(0, this.clock() - extra.started),
    });
  }

  /**
   * Policy check for a curated tool that does not call GitHub (github_subscribe): owner allowlist and policy for the
   * stated actions, the outcome in the activity log. Throws a denial written for the agent.
   */
  authorize(ctx: CallContext, repo: string, actions: Action[], detail = ""): void {
    const classified: Classified = { repo, owners: repo ? [repo.split("/")[0]!.toLowerCase()] : [], actions };
    const verdict = this.judge(classified);
    if (!verdict.allowed) this.refuse(ctx, classified, verdict.message, verdict);
    this.record(ctx, classified, "allowed", { detail, started: this.clock() });
  }

  private refuse(ctx: CallContext, c: Classified, message: string, by?: { rule: string | null; action: Action | null }): never {
    this.record(ctx, c, "denied", { detail: message, started: this.clock() });
    throw new ProxyError("denied", message, null, null, by ? { rule: by.rule, action: by.action } : null);
  }

  private async run(ctx: CallContext, p: Prepared): Promise<ProxyResponse> {
    const started = this.clock();
    const verdict = this.judge(p.classified);
    if (!verdict.allowed) {
      this.record(ctx, p.classified, "denied", { detail: verdict.message, started });
      throw new ProxyError("denied", verdict.message, null, null, { rule: verdict.rule, action: verdict.action });
    }
    try {
      const response = await this.fetchThrough(p);
      const status: ActivityStatus = response.served === "cache" ? "cached" : response.served === "revalidated" ? "revalidated" : "allowed";
      this.record(ctx, p.classified, response.served === "stale" ? "cached" : status, {
        httpStatus: response.status,
        source: response.source,
        app: response.app,
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

  /** The App that serves a call: the one claiming its owners, else the default one. Owners of two Apps cannot be mixed. */
  private appFor(owners: string[]): { app: AppEntry | null; problem?: string } {
    const apps = this.deps.apps.list();
    const found = new Map<string, AppEntry>();
    for (const owner of owners.length ? owners : [""]) {
      const app = resolveApp(apps, owner);
      if (!app) {
        return { app: null, problem: owner ? `No GitHub App serves the owner "${owner}". Ask the user to assign it to an App, or mark a default App, in GitHub Proxy → Auth.` : "No default GitHub App is set. Ask the user to mark one in GitHub Proxy → Auth." };
      }
      found.set(app.id, app);
    }
    if (found.size > 1) return { app: null, problem: `This call spans owners (${owners.join(", ")}) served by different GitHub Apps. Do not retry as is: split it into one call per owner.` };
    return { app: [...found.values()][0] ?? null };
  }

  private ghCredential(): Credential {
    return { key: "gh", source: "gh", label: "gh CLI", app: null, token: this.deps.gh };
  }

  private appCredential(p: Prepared): Credential {
    const { app, problem } = p.via ? { app: this.deps.apps.list().find((a) => a.id === p.via!.app) ?? null, problem: "That GitHub App no longer exists." } : this.appFor(p.owners);
    if (!app) return { key: "app:", source: "app", label: "GitHub App", app: null, token: null, problem: problem ?? "No GitHub App is configured. Ask the user to add one in GitHub Proxy → Auth." };
    return { key: appKey(app.id), source: "app", label: `GitHub App "${appName(app)}"`, app: appName(app), token: this.deps.apps.source(app.id) };
  }

  /** The credentials to try, in order: the active source, then the other one when fallback is on. */
  private credentials(p: Prepared, config: Config): Credential[] {
    if (p.via) return [this.appCredential(p)];
    const gh = this.ghCredential();
    const app = this.appCredential(p);
    const [first, second] = config.activeSource === "gh" ? [gh, app] : [app, gh];
    return config.fallbackOnRateLimit ? [first, second] : [first];
  }

  private async fetchThrough(p: Prepared): Promise<ProxyResponse> {
    const config = this.deps.config();
    const now = this.clock();
    const creds = this.credentials(p, config);
    const choice = chooseSources({
      candidates: creds.map((c) => ({ key: c.key, configured: !!c.token && !c.problem && (c.token.configured() as boolean) })),
      tracker: this.deps.tracker,
      resource: p.resource,
    });
    const byKey = new Map(creds.map((c) => [c.key, c]));
    const keyOf = (c: Credential) => cacheKey(p.method, p.url, p.accept ? `${p.body ?? ""}|${p.accept}` : p.body, c.key);
    const entryOf = (c: Credential | undefined) => (p.cacheable && c ? this.deps.cache.get(keyOf(c)) : undefined);
    const usable = choice.order.map((k) => byKey.get(k)!);

    // A fresh answer is looked up under the identity that would serve the call, never another one.
    const primary = usable[0];
    const primaryEntry = entryOf(primary);
    if (primary && primaryEntry && isFresh(primaryEntry, config.cacheTtlSeconds, now)) return this.fromEntry(primaryEntry, "cache", null, primary);

    // While nothing can be used, a stale answer of a credential this call may use beats an error.
    const stale = (): { entry: CacheEntry; cred: Credential } | undefined => {
      for (const c of creds) {
        const e = c.problem ? undefined : entryOf(c);
        if (e) return { entry: e, cred: c };
      }
      return undefined;
    };
    if (usable.length === 0) {
      const s = stale();
      if (s) return this.fromEntry(s.entry, "stale", null, s.cred);
      const b = choice.blocked;
      const blocking = b ? byKey.get(b.key) : undefined;
      if (b?.reason === "rate_limited" && b.until && blocking) throw new ProxyError("rate_limited", limitMessage(blocking.label, b.until, now), 429);
      throw new ProxyError("auth", blocking?.problem ?? `The ${blocking?.label ?? "selected credential"} is not configured. Ask the user to set it up in GitHub Proxy → Auth.`, 401);
    }

    let lastLimit: { cred: Credential; until: number } | null = null;
    for (const cred of usable) {
      try {
        const out = await this.send(cred, p, entryOf(cred), keyOf(cred));
        if (out.kind === "limited") {
          lastLimit = { cred, until: out.until };
          continue;
        }
        return out.response;
      } catch (error) {
        if (error instanceof AuthError) {
          if (usable.length > 1 && cred !== usable[usable.length - 1]) continue;
          throw new ProxyError("auth", error.message, 401);
        }
        throw error;
      }
    }
    const s = stale();
    if (s) return this.fromEntry(s.entry, "stale", lastLimit?.cred.source ?? null, s.cred);
    throw new ProxyError("rate_limited", limitMessage(lastLimit!.cred.label, lastLimit!.until, this.clock()), 429);
  }

  private fromEntry(entry: CacheEntry, served: ProxyResponse["served"], source: SourceId | null, cred: Credential): ProxyResponse {
    return { status: entry.status, data: parseBody(entry.body, entry.contentType), served, link: entry.link, etag: entry.etag, contentType: entry.contentType, source, app: cred.app };
  }

  private async send(cred: Credential, p: Prepared, entry: CacheEntry | undefined, key: string): Promise<{ kind: "ok"; response: ProxyResponse } | { kind: "limited"; until: number }> {
    const tokenSource = cred.token!;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await tokenSource.token();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: p.accept ?? "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "paseo-github-proxy",
      };
      if (p.body !== undefined) headers["Content-Type"] = "application/json";
      if (entry?.etag) headers["If-None-Match"] = entry.etag;
      const res = await this.deps.fetch(p.url, { method: p.method, headers, ...(p.body !== undefined ? { body: p.body } : {}) });
      const now = this.clock();
      const text = res.status === 304 ? "" : await res.text();
      this.deps.tracker.record(cred.key, parseRateLimit(res.headers, now));

      if (res.status === 401 && attempt === 0) {
        tokenSource.invalidate();
        continue;
      }
      const verdict = detectLimit(res.status, res.headers, text, now);
      if (verdict.limited) {
        this.deps.tracker.block(cred.key, verdict.until);
        return { kind: "limited", until: verdict.until };
      }
      if (res.status === 304 && entry) {
        this.deps.cache.touch(key, now);
        return { kind: "ok", response: this.fromEntry(entry, "revalidated", cred.source, cred) };
      }
      if (res.status >= 400) throw new ProxyError("http", httpMessage(res.status, text), res.status, text);

      const contentType = res.headers.get("content-type") ?? "application/json";
      if (p.cacheable) {
        this.deps.cache.set({ key, etag: res.headers.get("etag"), status: res.status, body: text, contentType, link: res.headers.get("link"), fetchedAt: now });
      } else if (p.method !== "GET") {
        // A write changes what the reads of that repo (or account) will say, whoever asked.
        for (const fragment of p.invalidates ?? (p.classified.repo ? [`/repos/${p.classified.repo}`] : [])) this.deps.cache.invalidate(fragment);
      }
      return { kind: "ok", response: { status: res.status, data: parseBody(text, contentType), served: "upstream", link: res.headers.get("link"), etag: res.headers.get("etag"), contentType, source: cred.source, app: cred.app } };
    }
    throw new ProxyError("auth", `GitHub rejected the credentials of the ${cred.label} (HTTP 401). Ask the user to check GitHub Proxy → Auth.`, 401);
  }

  overview(): Omit<Overview, "events"> {
    const config = this.deps.config();
    const now = this.clock();
    const warnings: string[] = [];
    const apps = this.deps.apps.list();
    const rows = [
      { source: "gh" as const, key: "gh", label: "gh CLI", owners: [] as string[], default: false, configured: this.deps.gh.configured() as boolean },
      ...apps.map((a) => ({ source: "app" as const, key: appKey(a.id), label: appName(a), owners: appOwners(a), default: a.default, configured: this.deps.apps.source(a.id).configured() as boolean })),
      // With no App yet, one placeholder keeps the "GitHub App: not configured" card.
      ...(apps.length === 0 ? [{ source: "app" as const, key: "app:", label: "GitHub App", owners: [] as string[], default: false, configured: false }] : []),
    ];
    const sources = rows.map((r) => {
      const limits = this.deps.tracker.limits(r.key);
      const blockedUntil = this.deps.tracker.blockedUntil(r.key);
      for (const l of limits) {
        if (l.limit > 0 && l.remaining / l.limit <= 0.1 && l.resetAt > now) warnings.push(`${r.source === "gh" ? "gh CLI" : `GitHub App "${r.label}"`}: ${l.resource} is nearly exhausted (${l.remaining}/${l.limit} left).`);
      }
      return { ...r, active: config.activeSource === r.source, blockedUntil, limits };
    });
    if (config.allowedOwners.length === 0) warnings.push("No allowed owner yet: every call is refused until you add one in Auth.");
    return { now, sources, stats: this.deps.activity.stats(this.deps.cache.size), allowedOwnersEmpty: config.allowedOwners.length === 0, warnings };
  }
}

/** The cached reads a REST write makes stale: its repository, else its account or collection (/orgs/acme, /gists, /notifications). */
function invalidationOf(repo: string, path: string): string[] {
  if (repo) return [`/repos/${repo}`];
  const parts = path.split("/").filter(Boolean);
  const keep = parts[0] === "orgs" || parts[0] === "users" ? 2 : 1;
  return parts.length ? [`/${parts.slice(0, keep).join("/")}`] : [];
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
  const queue = status === 405 && /merge queue/i.test(detail) ? " This repository only merges through its merge queue, so do not retry the direct merge. Use github_pr_manage with operation auto_merge (it adds the pull request to the queue), then check github_get_pr (merged, merge_queue) or wait with github_subscribe." : "";
  return `GitHub answered HTTP ${status}${hint}: ${detail}${queue}`;
}
