import { describe, expect, it } from "vitest";
import { detectLimit, formatClock, limitMessage, parseRateLimit, RateLimitTracker, resourceOf } from "./ratelimit";

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

describe("rate limit headers", () => {
  it("parses x-ratelimit-*", () => {
    const v = parseRateLimit(headers({ "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "42", "x-ratelimit-reset": "1700000000", "x-ratelimit-resource": "graphql" }), 1);
    expect(v).toEqual({ resource: "graphql", limit: 5000, remaining: 42, resetAt: 1700000000_000, observedAt: 1 });
    expect(parseRateLimit(headers({}), 1)).toBeNull();
  });
  it("detects a primary limit from a 403 with no remaining", () => {
    const v = detectLimit(403, headers({ "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000" }), "", 0);
    expect(v).toEqual({ limited: true, until: 2_000_000, secondary: false });
  });
  it("detects a secondary limit from retry-after or the body", () => {
    expect(detectLimit(429, headers({ "retry-after": "30" }), "", 1000)).toEqual({ limited: true, until: 31_000, secondary: true });
    expect(detectLimit(403, headers({}), "You have exceeded a secondary rate limit", 0).limited).toBe(true);
  });
  it("does not treat a plain 403 or a 200 as a limit", () => {
    expect(detectLimit(403, headers({ "x-ratelimit-remaining": "10", "x-ratelimit-limit": "60", "x-ratelimit-reset": "9" }), "Forbidden", 0).limited).toBe(false);
    expect(detectLimit(200, headers({}), "", 0).limited).toBe(false);
  });
});

describe("tracker", () => {
  it("blocks a source whose resource is exhausted until its reset, then releases it", () => {
    let now = 1000;
    const t = new RateLimitTracker(() => now);
    t.record("gh", { resource: "core", limit: 5000, remaining: 0, resetAt: 5000, observedAt: 1000 });
    expect(t.blockedUntil("gh")).toBe(5000);
    expect(t.blockedUntil("gh", "search")).toBeNull();
    expect(t.blockedUntil("app")).toBeNull();
    now = 5001;
    expect(t.blockedUntil("gh")).toBeNull();
    expect(t.limits("gh")[0]?.remaining).toBe(5000);
  });
  it("an explicit block (secondary limit) covers every resource", () => {
    const t = new RateLimitTracker(() => 0);
    t.block("app", 60_000);
    expect(t.blockedUntil("app", "search")).toBe(60_000);
  });
});

describe("helpers", () => {
  it("buckets paths and writes a retry-at message", () => {
    expect(resourceOf("/search/issues")).toBe("search");
    expect(resourceOf("/graphql")).toBe("graphql");
    expect(resourceOf("/repos/a/b")).toBe("core");
    const until = new Date(2026, 0, 1, 14, 7).getTime();
    expect(formatClock(until)).toBe("14:07");
    expect(limitMessage("gh", until, until - 600_000)).toMatch(/Retry at 14:07/);
  });
});
