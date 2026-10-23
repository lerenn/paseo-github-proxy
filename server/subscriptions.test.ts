import { statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxySettings } from "../shared/subscriptions";
import { SubscriptionManager } from "./subscriptions";
import { dynamicGithub, PR, tmp } from "./testing";

const gh = {
  sha: "s1", state: "open", merged: false,
  runs: [{ name: "ci", status: "in_progress", conclusion: null as string | null, html_url: "https://x/ci", app: { name: "A" }, output: {}, started_at: null, completed_at: null }],
  reviews: [] as object[], comments: [] as object[], reviewComments: [] as object[],
};
const api = (p: string) => {
  const m = p.replace(/\?.*/, "");
  if (m === "/repos/acme/app/pulls/7") return { ...PR, state: gh.state, merged_at: gh.merged ? "2026-01-01T00:00:00Z" : null, merged_by: { login: "carol" }, head: { ref: "feat", sha: gh.sha } };
  if (m.endsWith("/check-runs")) return { check_runs: gh.runs };
  if (m.endsWith("/status")) return { statuses: [] };
  if (m.endsWith("/pulls/7/reviews")) return gh.reviews;
  if (m.endsWith("/issues/7/comments")) return gh.comments;
  if (m.endsWith("/pulls/7/comments")) return gh.reviewComments;
  return undefined;
};

function setup(over: { healthy?: boolean; send?: (id: string, text: string) => Promise<void>; webhooks?: "auto" | "off" } = {}) {
  const { client, calls } = dynamicGithub(api);
  const sent: { agentId: string; text: string }[] = [];
  const forwarders = { ensure: vi.fn(), release: vi.fn(async () => {}), healthy: vi.fn(() => over.healthy ?? false) };
  const file = path.join(tmp(), "subs.json");
  const make = () =>
    new SubscriptionManager({
      ctx: () => ({ client }),
      send: over.send ?? (async (agentId, text) => void sent.push({ agentId, text })),
      settings: async () => proxySettings.schema.parse({ webhooks: over.webhooks ?? "auto" }),
      forwarders,
      file,
      settleMs: 20_000,
      tickMs: 15_000,
    });
  const mgr = make();
  mgr.start();
  return { mgr, make, sent, forwarders, calls, file };
}
const sub = (mgr: SubscriptionManager, events: any[] = ["checks_completed"], timeoutSeconds = 600, agentId: string | null = "agent-1") =>
  mgr.subscribe({ agentId }, { repo: "acme/app", number: 7, events, timeoutSeconds });

beforeEach(() => {
  vi.useFakeTimers({ now: 1_800_000_000_000 });
  Object.assign(gh, { sha: "s1", state: "open", merged: false, reviews: [], comments: [], reviewComments: [] });
  gh.runs = [{ name: "ci", status: "in_progress", conclusion: null, html_url: "https://x/ci", app: { name: "A" }, output: {}, started_at: null, completed_at: null }];
});
afterEach(() => vi.useRealTimers());

describe("SubscriptionManager", () => {
  it("wakes the agent when the checks finish, once, via polling", async () => {
    const { mgr, sent, forwarders } = setup();
    const r = await sub(mgr);
    expect(r).toHaveProperty("subscription");
    expect(forwarders.ensure).toHaveBeenCalledWith("acme/app");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(sent).toHaveLength(0);
    gh.runs = [{ ...gh.runs[0], status: "completed", conclusion: "success" }];
    await vi.advanceTimersByTimeAsync(61_000); // poll sees settled checks
    await vi.advanceTimersByTimeAsync(25_000); // settle window
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ agentId: "agent-1" });
    expect(sent[0].text).toContain("Checks finished on acme/app#7");
    expect(sent[0].text).toContain("all passed");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sent).toHaveLength(1);
    expect(mgr.list()[0]).toMatchObject({ status: "fired", outcome: "checks_completed" });
    expect(forwarders.release).toHaveBeenCalledWith("acme/app");
  });

  it("answers immediately when the condition already holds", async () => {
    const { mgr, forwarders } = setup();
    gh.runs = [{ ...gh.runs[0], status: "completed", conclusion: "failure" }];
    const r = await sub(mgr);
    expect(r).toEqual({ satisfied: expect.stringContaining("already finished: 1 failed") });
    expect(mgr.list()).toEqual([]);
    expect(forwarders.ensure).not.toHaveBeenCalled();
    gh.merged = true;
    expect(await sub(mgr, ["pr_merged"])).toEqual({ satisfied: expect.stringContaining("already merged") });
  });

  it("a webhook hint fires without waiting for the poll", async () => {
    const { mgr, sent } = setup({ healthy: true });
    await sub(mgr, ["review_submitted"]);
    gh.reviews = [{ id: 5, state: "APPROVED", user: { login: "bob" }, body: "ship it", html_url: "https://x/r" }];
    await mgr.hint("ACME/app", [7], []);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Review on acme/app#7 by bob: APPROVED");
    expect(sent[0].text).toContain("> ship it");
    expect(sent[0].text).toContain("not instructions");
  });

  it("resolves a hint that only names a commit", async () => {
    const { mgr, sent } = setup();
    await sub(mgr, ["pr_merged"]);
    gh.merged = true;
    gh.state = "closed";
    await mgr.hint("acme/app", [], ["s1"]);
    expect(sent[0].text).toContain("was merged by carol");
  });

  it("fires only once when the webhook and the poll both see the event", async () => {
    const { mgr, sent } = setup();
    await sub(mgr, ["comment_created"]);
    gh.comments = [{ id: 1, user: { login: "bob" }, body: "hi" }];
    await Promise.all([mgr.hint("acme/app", [7], []), mgr.hint("acme/app", [7], [])]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(1);
  });

  it("sends a timeout notice with the current state", async () => {
    const { mgr, sent } = setup();
    await sub(mgr, ["review_submitted"], 120);
    await vi.advanceTimersByTimeAsync(121_000);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("timed out");
    expect(sent[0].text).toContain("within 120 seconds");
    expect(sent[0].text).toContain("Current state: open");
    expect(mgr.list()[0].status).toBe("timed_out");
  });

  it("reports an event rather than a timeout when the event arrived unseen", async () => {
    const { mgr, sent } = setup();
    await sub(mgr, ["review_submitted"], 100);
    gh.reviews = [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "bob" }, body: "no" }];
    await vi.advanceTimersByTimeAsync(40_000); // before the first poll
    await vi.advanceTimersByTimeAsync(61_000);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("CHANGES_REQUESTED");
    expect(sent[0].text).not.toContain("timed out");
  });

  it("caps the timeout at the configured maximum", async () => {
    const { mgr } = setup();
    const r = (await sub(mgr, ["review_submitted"], 10 * 3600)) as { subscription: { deadline: string; createdAt: string } };
    expect(Date.parse(r.subscription.deadline) - Date.parse(r.subscription.createdAt)).toBe(240 * 60 * 1000);
  });

  it("never polls faster than 60 seconds", async () => {
    const { mgr, calls } = setup();
    await sub(mgr, ["review_submitted"], 3600);
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(59_000);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.length).toBeGreaterThan(0);
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(45_000);
    expect(calls).toHaveLength(0);
  });

  it("polls slower while the webhook forwarder is healthy", async () => {
    const { mgr, calls } = setup({ healthy: true });
    await sub(mgr, ["review_submitted"], 3600);
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(200_000);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(110_000);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("does not start forwarders when webhooks are off", async () => {
    const { mgr, forwarders } = setup({ webhooks: "off" });
    await sub(mgr, ["review_submitted"]);
    expect(forwarders.ensure).not.toHaveBeenCalled();
  });

  it("refuses sessions that are not bound to an agent, and empty event lists", async () => {
    const { mgr } = setup();
    await expect(sub(mgr, ["pr_merged"], 600, null)).rejects.toThrow("not bound");
    await expect(sub(mgr, [])).rejects.toThrow("at least one event");
  });

  it("cancels only the caller's own subscription", async () => {
    const { mgr, sent } = setup();
    const { subscription } = (await sub(mgr, ["review_submitted"])) as { subscription: { id: string } };
    expect(mgr.cancel(subscription.id, "someone-else")).toBe(false);
    expect(mgr.cancel(subscription.id, "agent-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(700_000);
    expect(sent).toHaveLength(0);
    expect(mgr.list()[0].status).toBe("cancelled");
  });

  it("drops subscriptions of an archived agent", async () => {
    const { mgr } = setup();
    await sub(mgr, ["review_submitted"]);
    mgr.dropAgent("agent-1");
    expect(mgr.list()[0]).toMatchObject({ status: "cancelled", outcome: "agent archived" });
  });

  it("restores subscriptions after a restart and times out the ones that expired meanwhile", async () => {
    const first = setup();
    await sub(first.mgr, ["review_submitted"], 100);
    first.mgr.stop();
    expect(statSync(first.file).mode & 0o777).toBe(0o600);
    vi.setSystemTime(Date.now() + 500_000);
    const sent2: string[] = [];
    const again = new SubscriptionManager({
      ctx: () => ({ client: dynamicGithub(api).client }),
      send: async (_id, text) => void sent2.push(text),
      settings: async () => proxySettings.schema.parse({}),
      forwarders: { ensure: vi.fn(), release: vi.fn(async () => {}), healthy: () => false },
      file: first.file,
    });
    again.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent2).toHaveLength(1);
    expect(sent2[0]).toContain("daemon was restarted");
  });

  it("retries a failed wake-up and gives up cleanly", async () => {
    let attempts = 0;
    const { mgr } = setup({ send: async () => { attempts++; throw new Error("agent not found"); } });
    await sub(mgr, ["review_submitted"], 60);
    await vi.advanceTimersByTimeAsync(60_000 + 20_000);
    expect(attempts).toBe(3);
    expect(mgr.list()[0].outcome).toContain("agent unreachable");
  });

  it("keeps only recent finished subscriptions", async () => {
    const { mgr } = setup();
    for (let i = 0; i < 25; i++) {
      const r = (await sub(mgr, ["review_submitted"])) as { subscription: { id: string } };
      mgr.cancel(r.subscription.id);
    }
    expect(mgr.list().length).toBeLessThanOrEqual(20);
  });
});
