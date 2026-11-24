import type { SourceId } from "../shared/config";
import type { RateLimitView } from "../shared/state";

export interface HeaderLike {
  get(name: string): string | null;
}

export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Reads GitHub's `x-ratelimit-*` headers. Null when the response carries none. */
export function parseRateLimit(headers: HeaderLike, now: number): RateLimitView | null {
  const limit = Number(headers.get("x-ratelimit-limit"));
  const remaining = Number(headers.get("x-ratelimit-remaining"));
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (!headers.get("x-ratelimit-limit") || !Number.isFinite(limit) || !Number.isFinite(remaining) || !Number.isFinite(reset)) return null;
  return { resource: headers.get("x-ratelimit-resource") ?? "core", limit, remaining, resetAt: reset * 1000, observedAt: now };
}

export interface LimitVerdict {
  /** True when this response says "stop": a primary or secondary limit. */
  limited: boolean;
  /** Epoch ms until which the source (or the resource) should not be used. */
  until: number;
  secondary: boolean;
}

/** Decides from a 403/429 response whether GitHub is rate-limiting us, and until when. */
export function detectLimit(status: number, headers: HeaderLike, body: string, now: number): LimitVerdict {
  const none: LimitVerdict = { limited: false, until: 0, secondary: false };
  if (status !== 403 && status !== 429) return none;
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && headers.get("retry-after")) return { limited: true, until: now + retryAfter * 1000, secondary: true };
  const info = parseRateLimit(headers, now);
  if (info && info.remaining === 0) return { limited: true, until: info.resetAt, secondary: false };
  if (/secondary rate limit|abuse detection/i.test(body)) return { limited: true, until: now + 60_000, secondary: true };
  if (status === 429) return { limited: true, until: info?.resetAt ?? now + 60_000, secondary: false };
  return none;
}

/** Remembers the last rate-limit reading per source and resource, and which sources are refused until when. */
export class RateLimitTracker {
  private readings = new Map<string, RateLimitView>();
  private blocks = new Map<string, number>();

  constructor(private readonly clock: () => number = Date.now) {}

  record(source: SourceId, view: RateLimitView | null): void {
    if (view) this.readings.set(`${source}:${view.resource}`, view);
  }

  /** Refuse the source (every resource) until the given time. */
  block(source: SourceId, until: number): void {
    this.blocks.set(source, Math.max(until, this.blocks.get(source) ?? 0));
  }

  /** Epoch ms until which the source is refused for the resource, or null if it can be used. */
  blockedUntil(source: SourceId, resource = "core"): number | null {
    const now = this.clock();
    const explicit = this.blocks.get(source);
    if (explicit !== undefined && explicit > now) return explicit;
    const reading = this.readings.get(`${source}:${resource}`);
    if (reading && reading.remaining <= 0 && reading.resetAt > now) return reading.resetAt;
    return null;
  }

  limits(source: SourceId): RateLimitView[] {
    const now = this.clock();
    // A window that has reset is full again: show it as such rather than a stale low count.
    return [...this.readings.entries()]
      .filter(([key]) => key.startsWith(`${source}:`))
      .map(([, r]) => (r.resetAt <= now ? { ...r, remaining: r.limit } : r))
      .sort((a, b) => a.resource.localeCompare(b.resource));
  }

  clear(source: SourceId): void {
    this.blocks.delete(source);
    for (const key of [...this.readings.keys()]) if (key.startsWith(`${source}:`)) this.readings.delete(key);
  }
}

/** The resource bucket a path counts against. */
export function resourceOf(path: string): string {
  if (path.startsWith("/search/")) return "search";
  if (path === "/graphql") return "graphql";
  return "core";
}

export function limitMessage(source: SourceId, until: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
  return `GitHub rate limit reached for the ${source === "gh" ? "gh CLI" : "GitHub App"} credentials. Retry at ${formatClock(until)} (in about ${minutes} min). Do not retry before then; use cached or already fetched data meanwhile.`;
}
