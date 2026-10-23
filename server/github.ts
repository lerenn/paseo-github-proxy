import type { Priority, Resource } from "../shared/budget";
import { EtagCache } from "./cache";
import { RateLimiter } from "./limiter";
import { normalizeOwner, scrub, tokenKey, type TokenStore } from "./tokens";

export const API = "https://api.github.com";

export class NoTokenError extends Error {
  constructor(readonly owner: string) {
    super(`No GitHub token for ${owner}. Add one in the GitHub proxy screen.`);
    this.name = "NoTokenError";
  }
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface RestRequest {
  owner: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path starting with `/`, query string included. */
  path: string;
  body?: unknown;
  priority?: Priority;
  /** Bypass the ETag cache. */
  fresh?: boolean;
}

export interface RestResponse<T = unknown> {
  status: number;
  data: T;
  /** Served from the ETag cache after a 304. */
  cached: boolean;
  /** Value of the `Link` header, for pagination. */
  link: string | null;
}

export interface ClientOptions {
  tokens: TokenStore;
  limiter?: RateLimiter;
  cache?: EtagCache;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export function resourceFor(path: string): Resource {
  if (path.startsWith("/graphql")) return "graphql";
  if (path.startsWith("/search/")) return "search";
  return "core";
}

/**
 * The only code path that talks to GitHub. Picks the token by owner, goes through the shared
 * per-token rate limiter, and revalidates REST reads with ETags.
 */
export class GitHubClient {
  readonly limiter: RateLimiter;
  readonly cache: EtagCache;
  private readonly tokens: TokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;

  constructor(options: ClientOptions) {
    this.tokens = options.tokens;
    this.limiter = options.limiter ?? new RateLimiter();
    this.cache = options.cache ?? new EtagCache();
    this.fetchImpl = options.fetch ?? fetch;
    this.base = options.baseUrl ?? API;
  }

  /** Rate-limit identity of an owner's token. */
  budgetKey(owner: string): string {
    const token = this.tokens.get(owner);
    if (!token) throw new NoTokenError(normalizeOwner(owner));
    return tokenKey(token);
  }

  async rest<T = unknown>(req: RestRequest): Promise<RestResponse<T>> {
    const owner = normalizeOwner(req.owner);
    const token = this.tokens.get(owner);
    if (!token) throw new NoTokenError(owner);
    const method = req.method ?? "GET";
    const url = `${this.base}${req.path}`;
    const cacheKey = `${tokenKey(token)}:${url}`;
    const cached = method === "GET" && !req.fresh ? this.cache.get(cacheKey) : undefined;

    const res = await this.limiter.schedule(
      tokenKey(token),
      { resource: resourceFor(req.path), priority: req.priority ?? "normal", write: method !== "GET" },
      () =>
        this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "paseo-github-proxy",
            ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
            ...(cached ? { "if-none-match": cached.etag } : {}),
          },
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        }),
    );

    if (res.status === 304 && cached) {
      this.cache.hits++;
      return { status: cached.status, data: cached.data as T, cached: true, link: cached.link };
    }
    if (method === "GET") this.cache.misses++;
    const data = await parseBody(res);
    if (!res.ok) {
      const message = typeof data === "object" && data && "message" in data ? String((data as { message: unknown }).message) : res.statusText;
      throw new GitHubError(scrub(`GitHub ${res.status} on ${method} ${req.path}: ${message}`, token), res.status, data);
    }
    const link = res.headers.get("link");
    const etag = res.headers.get("etag");
    if (method === "GET" && etag) this.cache.set(cacheKey, { etag, status: res.status, data, link });
    return { status: res.status, data: data as T, cached: false, link };
  }

  /** Follow `Link: rel="next"` and concatenate array pages. */
  async restAll<T = unknown>(req: RestRequest, maxPages = 10): Promise<T[]> {
    const out: T[] = [];
    let path = req.path;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.rest<T[]>({ ...req, path });
      out.push(...res.data);
      const next = res.link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      if (!next) break;
      const parsed = new URL(next);
      path = parsed.pathname + parsed.search;
    }
    return out;
  }

  async graphql<T = unknown>(req: { owner: string; query: string; variables?: Record<string, unknown>; priority?: Priority }): Promise<T> {
    const res = await this.rest<{ data?: T; errors?: { message: string }[] }>({
      owner: req.owner,
      method: "POST",
      path: "/graphql",
      body: { query: req.query, variables: req.variables ?? {} },
      priority: req.priority,
    });
    if (res.data.errors?.length && res.data.data === undefined) {
      throw new GitHubError(`GraphQL: ${res.data.errors.map((e) => e.message).join("; ")}`, 200, res.data);
    }
    return res.data.data as T;
  }

  /** Read GitHub's own view of the budget. `/rate_limit` does not consume any. */
  async refreshBudget(owner: string) {
    const res = await this.rest<{ resources: Record<string, { limit: number; remaining: number; reset: number }> }>({
      owner,
      path: "/rate_limit",
      priority: "interactive",
      fresh: true,
    });
    this.limiter.observeResources(this.budgetKey(owner), res.data.resources);
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
