import { describe, expect, it, vi } from "vitest";
import { defaultConfig, type AppEntry } from "../shared/config";
import { ActivityLog } from "./activity";
import type { FetchFn, TokenSource } from "./auth";
import { ResponseCache } from "./cache";
import { eventOwner, parseEvent, shorten, staleKeyTest } from "./events";
import { GithubProxy } from "./proxy";
import { RateLimitTracker } from "./ratelimit";

const repo = { full_name: "Acme/Web", owner: { login: "Acme" } };
const key = (path: string) => `GET https://api.github.com${path} as app:a`;

describe("parseEvent", () => {
  it("normalizes a merged pull request, with a short single-line title", () => {
    const p = parseEvent("pull_request", { action: "closed", repository: repo, pull_request: { number: 7, merged: true, title: `a\nb ${"x".repeat(200)}`, head: { sha: "ABCDEF1" } }, sender: { login: "bob" } })!;
    expect(p.wake).toMatchObject({ kind: "pr_merged", repo: "acme/web", numbers: [7], sha: "abcdef1", actor: "bob" });
    expect(p.wake!.title.length).toBeLessThanOrEqual(100);
    expect(p.wake!.title).not.toContain("\n");
  });
  it("tells a closed PR from a merged one, and reads check conclusions", () => {
    expect(parseEvent("pull_request", { action: "closed", repository: repo, pull_request: { number: 1, merged: false } })!.wake!.kind).toBe("pr_closed");
    const c = parseEvent("check_suite", { action: "completed", repository: repo, check_suite: { head_sha: "deadbeef", conclusion: "FAILURE", pull_requests: [{ number: 3 }], app: { name: "CI" } } })!;
    expect(c.wake).toMatchObject({ kind: "checks_completed", conclusion: "failure", numbers: [3], sha: "deadbeef" });
    expect(parseEvent("check_suite", { action: "requested", repository: repo, check_suite: {} })!.wake).toBeNull();
    expect(parseEvent("status", { repository: repo, sha: "abc", state: "pending" })!.wake).toBeNull();
    expect(parseEvent("status", { repository: repo, sha: "abc", state: "error" })!.wake!.conclusion).toBe("failure");
  });
  it("reads reviews and comments; ignores events it does not use", () => {
    expect(parseEvent("pull_request_review", { action: "submitted", repository: repo, pull_request: { number: 2 }, review: { state: "APPROVED" } })!.wake).toMatchObject({ kind: "review_submitted", conclusion: "approved" });
    expect(parseEvent("issue_comment", { action: "created", repository: repo, issue: { number: 4, title: "t" } })!.wake).toMatchObject({ kind: "comment_added", numbers: [4] });
    expect(parseEvent("star", { repository: repo })).toBeNull();
    expect(parseEvent("pull_request", { action: "opened" })).toBeNull();
  });
  it("finds the owner of a delivery", () => {
    expect(eventOwner({ repository: repo })).toBe("acme");
    expect(eventOwner({ organization: { login: "Org" } })).toBe("org");
    expect(eventOwner({})).toBe("");
    expect(shorten("  a   b  ")).toBe("a b");
  });
});

describe("staleKeyTest", () => {
  const stale = (name: string, payload: object) => staleKeyTest(parseEvent(name, payload)!);
  it("a PR event drops that repo's PR, issue and commit reads, the repo page, GraphQL and searches; not other repos or files", () => {
    const t = stale("pull_request", { action: "synchronize", repository: repo, pull_request: { number: 5 } });
    for (const p of ["/repos/Acme/Web/pulls/5", "/repos/acme/web/pulls?state=open", "/repos/acme/web/issues/5/comments", "/repos/acme/web/commits/abc/check-runs", "/graphql", "/search/issues?q=x"]) expect(t(key(p))).toBe(true);
    expect(t("GET https://api.github.com/repos/acme/web as gh")).toBe(true);
    expect(t(key("/repos/acme/web2/pulls/5"))).toBe(false);
    expect(t(key("/repos/acme/other/pulls/5"))).toBe(false);
    expect(t(key("/repos/acme/web/contents/README.md"))).toBe(false);
  });
  it("a push drops the whole repository", () => {
    const t = stale("push", { repository: repo });
    expect(t(key("/repos/acme/web/contents/README.md"))).toBe(true);
    expect(t(key("/repos/acme/web/branches"))).toBe(true);
    expect(t(key("/repos/acme/web2/branches"))).toBe(false);
  });
});

describe("event driven cache", () => {
  const app: AppEntry = { id: "a", organization: "acme", label: "", appId: "1", installationId: "1", owners: [], default: true };
  function setup() {
    let title = "old";
    let calls = 0;
    const fetchFn: FetchFn = vi.fn(async () => {
      calls++;
      return { status: 200, headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null) }, text: async () => JSON.stringify({ number: 5, title }) };
    });
    const token = (id: "gh" | "app"): TokenSource => ({ id, configured: () => id === "app", token: async () => "t", invalidate: () => undefined });
    const cache = new ResponseCache(null);
    const proxy = new GithubProxy({ config: () => ({ ...defaultConfig(), activeSource: "app", allowedOwners: ["acme"], cacheTtlSeconds: 3600 }), gh: token("gh"), apps: { list: () => [app], source: () => token("app") }, fetch: fetchFn, cache, tracker: new RateLimitTracker(), activity: new ActivityLog() });
    return { proxy, cache, calls: () => calls, setTitle: (t: string) => (title = t) };
  }
  const ctx = { agentId: "a", agentTitle: "A", tool: "t" };
  const read = (t: ReturnType<typeof setup>) => t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/web/pulls/5", actions: ["read"] });

  it("serves the cached read within the ttl, and the fresh one after an event", async () => {
    const t = setup();
    expect(((await read(t)).data as any).title).toBe("old");
    t.setTitle("new");
    expect(((await read(t)).data as any).title).toBe("old"); // within the TTL, no event: cached
    expect(t.calls()).toBe(1);
    t.cache.invalidateWhere(staleKeyTest(parseEvent("pull_request", { action: "edited", repository: repo, pull_request: { number: 5 } })!));
    expect(((await read(t)).data as any).title).toBe("new"); // stale data is not served after the event
    expect(t.calls()).toBe(2);
  });

  it("an event for another repository leaves the cache alone", async () => {
    const t = setup();
    await read(t);
    t.cache.invalidateWhere(staleKeyTest(parseEvent("pull_request", { action: "edited", repository: { full_name: "acme/other" }, pull_request: { number: 5 } })!));
    await read(t);
    expect(t.calls()).toBe(1);
  });
});
