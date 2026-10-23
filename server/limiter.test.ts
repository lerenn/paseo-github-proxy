import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError, RateLimiter } from "./limiter";

const reset = () => Math.floor(Date.now() / 1000) + 100;
function ok(remaining = 4000, limit = 5000, resetAt = reset(), resource = "core") {
  return new Response("{}", {
    status: 200,
    headers: {
      "x-ratelimit-limit": String(limit),
      "x-ratelimit-remaining": String(remaining),
      "x-ratelimit-reset": String(resetAt),
      "x-ratelimit-resource": resource,
    },
  });
}
const job = (priority: "interactive" | "normal" | "background" = "normal", extra = {}) => ({ resource: "core" as const, priority, ...extra });

beforeEach(() => vi.useFakeTimers({ now: 1_000_000_000_000 }));
afterEach(() => vi.useRealTimers());

describe("RateLimiter", () => {
  it("tracks the budget from response headers", async () => {
    const l = new RateLimiter();
    await l.schedule("k", job(), async () => ok(4321, 5000));
    const core = l.snapshot("k").resources.find((r) => r.resource === "core")!;
    expect(core.limit).toBe(5000);
    expect(core.remaining).toBe(4321);
  });

  it("shares one budget per key but not across keys", async () => {
    const l = new RateLimiter();
    await l.schedule("a", job(), async () => ok(10, 5000));
    expect(l.snapshot("b").resources[0].remaining).toBeNull();
    expect(l.snapshot("a").resources[0].remaining).toBe(10);
  });

  it("starts higher priorities first", async () => {
    const l = new RateLimiter({ concurrency: 1 });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = l.schedule("k", job(), async () => (await gate, ok()));
    const mk = (name: string, p: "interactive" | "normal" | "background") =>
      l.schedule("k", job(p), async () => (order.push(name), ok()));
    const all = [mk("bg", "background"), mk("normal", "normal"), mk("ui", "interactive")];
    release();
    await first;
    await Promise.all(all);
    expect(order).toEqual(["ui", "normal", "bg"]);
  });

  it("limits concurrency per key", async () => {
    const l = new RateLimiter({ concurrency: 2 });
    let running = 0;
    let peak = 0;
    const run = () =>
      l.schedule("k", job(), async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
        return ok();
      });
    const all = Promise.all([run(), run(), run(), run(), run()]);
    await vi.runAllTimersAsync();
    await all;
    expect(peak).toBe(2);
  });

  it("holds background work when the bucket is low but lets interactive through", async () => {
    const l = new RateLimiter({ maxWaitMs: 10_000 });
    await l.schedule("k", job(), async () => ok(100, 5000)); // 2% left
    const sent = vi.fn(async () => ok(99, 5000));
    await expect(l.schedule("k", job("background"), sent)).rejects.toBeInstanceOf(RateLimitError);
    expect(sent).not.toHaveBeenCalled();
    await l.schedule("k", job("interactive"), sent);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("waits for the window to reset when the bucket is empty", async () => {
    const l = new RateLimiter({ maxWaitMs: 200_000 });
    await l.schedule("k", job("interactive"), async () => ok(0, 5000));
    const sent = vi.fn(async () => ok(4999, 5000));
    const p = l.schedule("k", job("interactive"), sent);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(sent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("pauses on a secondary limit with Retry-After, then retries once", async () => {
    const l = new RateLimiter({ maxWaitMs: 120_000 });
    const send = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response('{"message":"You have exceeded a secondary rate limit"}', { status: 403, headers: { "retry-after": "30" } }))
      .mockResolvedValueOnce(ok());
    const p = l.schedule("k", job(), send);
    await vi.advanceTimersByTimeAsync(1);
    expect(l.snapshot("k").pausedUntil).not.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31_000);
    const res = await p;
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("backs off exponentially on a secondary limit without Retry-After", async () => {
    const l = new RateLimiter({ maxWaitMs: 10 * 60_000, baseBackoffMs: 60_000 });
    const blocked = () => new Response('{"message":"secondary rate limit"}', { status: 403 });
    const send = vi.fn<() => Promise<Response>>().mockImplementation(async () => blocked());
    const p = l.schedule("k", job(), send);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(1);
    const first = l.snapshot("k").pausedUntil! - Date.now();
    expect(first).toBeGreaterThan(55_000);
    expect(first).toBeLessThanOrEqual(60_000);
    await vi.advanceTimersByTimeAsync(61_000);
    const second = l.snapshot("k").pausedUntil! - Date.now();
    expect(second).toBeGreaterThan(115_000);
    await vi.advanceTimersByTimeAsync(121_000);
    await expect(p).rejects.toBeInstanceOf(RateLimitError);
  });

  it("treats a primary 403 with remaining 0 as a pause until reset", async () => {
    const l = new RateLimiter({ maxWaitMs: 10_000 });
    const res = new Response('{"message":"API rate limit exceeded"}', {
      status: 403,
      headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset()) },
    });
    await expect(l.schedule("k", job(), async () => res)).rejects.toMatchObject({ name: "RateLimitError" });
    expect(l.snapshot("k").pauseReason).toContain("primary");
  });

  it("does not treat an ordinary 403 as a rate limit", async () => {
    const l = new RateLimiter();
    const res = await l.schedule("k", job(), async () => new Response('{"message":"Resource not accessible"}', { status: 403 }));
    expect(res.status).toBe(403);
    expect(l.snapshot("k").pausedUntil).toBeNull();
  });

  it("detects GraphQL RATE_LIMITED in a 200", async () => {
    const l = new RateLimiter({ maxWaitMs: 10_000 });
    const body = JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] });
    const blocked = new Response(body, { status: 200, headers: { "content-type": "application/json", "x-ratelimit-resource": "graphql" } });
    await expect(l.schedule("k", { resource: "graphql", priority: "normal" }, async () => blocked)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("spaces writes", async () => {
    const l = new RateLimiter({ writeGapMs: 1000 });
    const times: number[] = [];
    const w = () => l.schedule("k", job("normal", { write: true }), async () => (times.push(Date.now()), ok()));
    const all = Promise.all([w(), w()]);
    await vi.advanceTimersByTimeAsync(2000);
    await all;
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000);
  });

  it("seeds buckets from /rate_limit resources", () => {
    const l = new RateLimiter();
    l.observeResources("k", { core: { limit: 5000, remaining: 4000, reset: reset() }, graphql: { limit: 5000, remaining: 10, reset: reset() } });
    const snap = l.snapshot("k");
    expect(snap.resources.find((r) => r.resource === "graphql")!.remaining).toBe(10);
  });
});
