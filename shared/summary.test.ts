import { describe, expect, it } from "vitest";
import type { OwnerStatus } from "./rpc";
import { budgetTotals, describeSubscription, statusLine } from "./summary";

const owner = (name: string, remaining: number | null, limit: number | null, shares: string[] = []): OwnerStatus => ({
  owner: name, sharesBudgetWith: shares, error: null,
  budget: { resources: [{ resource: "core", remaining, limit, resetAt: null }], queued: 0, inFlight: 0, pausedUntil: null, pauseReason: null },
});

describe("statusLine", () => {
  it("matches the example from the brief", () => {
    expect(statusLine({ running: true, owners: [owner("a", 2000, 2000), owner("b", 2812, 3000)], scope: "opt-in" }))
      .toBe("Proxy running · 2 tokens · 4,812/5,000 requests left · lockout: opt-in");
  });
  it("handles no tokens, one token, unknown budget and a stopped proxy", () => {
    expect(statusLine({ running: false, owners: [], scope: "all" })).toBe("Proxy not running · no tokens yet · lockout: all agents");
    expect(statusLine({ running: true, owners: [owner("a", null, null)], scope: null })).toBe("Proxy running · 1 token");
  });
  it("counts a shared token's budget once", () => {
    expect(budgetTotals([owner("a", 10, 100, ["b"]), owner("b", 10, 100, ["a"])])).toEqual({ remaining: 10, limit: 100 });
  });
});

describe("describeSubscription", () => {
  it("says what the agent waits for in plain words", () => {
    const text = describeSubscription({ repo: "acme/app", number: 7, events: ["checks_completed", "review_submitted"], agentId: "1234567890", deadline: "2026-01-01T12:30:00Z" });
    expect(text).toContain("An agent (12345678) is waiting for the checks to finish or a review on acme/app#7, until");
  });
});
