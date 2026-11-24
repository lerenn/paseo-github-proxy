import { describe, expect, it } from "vitest";
import { parseEvent, WEBHOOK_EVENTS, WEBHOOK_EVENTS_CACHE_ONLY, WAKE_KINDS, type WakeEvent } from "./events";
import { SubscriptionStore, MAX_TTL_MINUTES, matches } from "./subscriptions";
import { wakePrompt } from "./wakeups";

const repo = { full_name: "Acme/Web", owner: { login: "Acme" } };
const wake = (name: string, payload: Record<string, unknown>): WakeEvent => parseEvent(name, { repository: repo, ...payload })!.wake!;
const sub = (extra: Record<string, unknown>, kinds: string[] = ["checks_completed"]) =>
  new SubscriptionStore(null).add({ agentId: "a", agentTitle: "A", repo: "acme/web", events: kinds as never, ...extra });

describe("repo-level check events", () => {
  const run = { action: "completed", workflow_run: { head_sha: "ABCDEF123456", head_branch: "main", name: "CI", conclusion: "success", pull_requests: [] } };
  it("workflow_run on a branch has no PR and carries branch, workflow and sha", () => {
    const e = wake("workflow_run", run);
    expect(e).toMatchObject({ kind: "checks_completed", numbers: [], sha: "abcdef123456", refs: ["main"], workflow: "CI", conclusion: "success" });
    expect(matches(sub({ branch: "main" }), e)).toBe(true);
    expect(matches(sub({ branch: "develop" }), e)).toBe(false);
    expect(matches(sub({ branch: "ma*" }), e)).toBe(true);
    expect(matches(sub({ branch: "refs/heads/main" }), e)).toBe(true);
    expect(matches(sub({ sha: "abcdef1" }), e)).toBe(true);
    expect(matches(sub({ sha: "1234567" }), e)).toBe(false);
    expect(matches(sub({ workflow: "ci" }), e)).toBe(true);
    expect(matches(sub({ workflow: "deploy" }), e)).toBe(false);
    expect(matches(sub({ branch: "main", workflow: "deploy" }), e)).toBe(false);
    expect(matches(sub({ conclusion: undefined, conclusions: ["failure"] }), e)).toBe(false);
  });
  it("a tag-triggered build matches the tag filter, a branch-only filter by name too", () => {
    const e = wake("workflow_run", { action: "completed", workflow_run: { head_sha: "abc1234", head_branch: "v1.2.3", name: "Release", conclusion: "success" } });
    expect(matches(sub({ tag: "v1.2.3" }), e)).toBe(true);
    expect(matches(sub({ tag: "v*" }), e)).toBe(true);
    expect(matches(sub({ tag: "v2.0.0" }), e)).toBe(false);
  });
  it("applies the sha filter to check_run, check_suite and status", () => {
    const events = [
      wake("check_run", { action: "completed", check_run: { head_sha: "deadbeef1", name: "lint", conclusion: "failure", check_suite: { head_branch: "main" } } }),
      wake("check_suite", { action: "completed", check_suite: { head_sha: "deadbeef1", head_branch: "main", conclusion: "failure", app: { name: "GitHub Actions" } } }),
      wake("workflow_run", { action: "completed", workflow_run: { head_sha: "deadbeef1", conclusion: "failure", name: "CI" } }),
      wake("status", { sha: "deadbeef1", state: "error", context: "ci/legacy", branches: [{ name: "main" }, { name: "x" }] }),
    ];
    for (const e of events) {
      expect(e.sha).toBe("deadbeef1");
      expect(matches(sub({ sha: "deadbeef" }), e)).toBe(true);
      expect(matches(sub({ sha: "cafebabe" }), e)).toBe(false);
    }
    expect(events[3]).toMatchObject({ conclusion: "failure", refs: ["main", "x"], workflow: "ci/legacy" });
    expect(matches(sub({ branch: "x" }), events[3]!)).toBe(true);
    expect(matches(sub({ workflow: "lint" }), events[0]!)).toBe(true);
  });
  it("ignores check events that are not finished", () => {
    expect(parseEvent("workflow_run", { repository: repo, action: "requested", workflow_run: {} })!.wake).toBeNull();
    expect(parseEvent("check_run", { repository: repo, action: "created", check_run: {} })!.wake).toBeNull();
    expect(parseEvent("status", { repository: repo, sha: "abc1234", state: "pending" })!.wake).toBeNull();
  });
});

describe("push and release", () => {
  it("push to a branch and to a tag", () => {
    const b = wake("push", { ref: "refs/heads/main", after: "ABC1234567", head_commit: { message: "fix: x\n\nbody" } });
    expect(b).toMatchObject({ kind: "push", refs: ["main"], refType: "branch", sha: "abc1234567", title: "fix: x body" });
    const t = wake("push", { ref: "refs/tags/v1.0.0", after: "def1234567" });
    expect(t).toMatchObject({ refs: ["v1.0.0"], refType: "tag" });
    const events = ["push" as const];
    expect(matches(sub({ branch: "main" }, events), b)).toBe(true);
    expect(matches(sub({ branch: "main" }, events), t)).toBe(false);
    expect(matches(sub({ tag: "v*" }, events), t)).toBe(true);
    expect(matches(sub({ tag: "v*" }, events), b)).toBe(false); // a branch named like a tag filter
    expect(matches(sub({ tag: "v2*" }, events), t)).toBe(false);
    expect(matches(sub({ sha: "abc1234" }, events), b)).toBe(true);
  });
  it("a branch deletion does not wake", () => {
    expect(parseEvent("push", { repository: repo, ref: "refs/heads/old", deleted: true, after: "0".repeat(40) })!.wake).toBeNull();
  });
  it("release published, not drafted or edited", () => {
    const e = wake("release", { action: "published", release: { tag_name: "v1.0.0", name: "One", target_commitish: "main", html_url: "https://x" } });
    expect(e).toMatchObject({ kind: "release_published", refs: ["v1.0.0"], refType: "tag", title: "One", sha: "" });
    expect(matches(sub({ tag: "v1.0.0" }, ["release_published"]), e)).toBe(true);
    expect(matches(sub({ tag: "v1.0.1" }, ["release_published"]), e)).toBe(false);
    expect(parseEvent("release", { repository: repo, action: "created", release: { tag_name: "v1" } })!.wake).toBeNull();
    expect(parseEvent("release", { repository: repo, action: "edited", release: { tag_name: "v1" } })!.wake).toBeNull();
  });
});

describe("merge queue and auto-merge", () => {
  const group = (action: string, reason?: string) => wake("merge_group", { action, ...(reason ? { reason } : {}), merge_group: { head_sha: "FEED1234567", head_ref: "refs/heads/gh-readonly-queue/main/pr-42-abc123", base_ref: "refs/heads/main" } });
  it("reads the PR number from the queue branch and the destroy reason", () => {
    const req = group("checks_requested");
    expect(req).toMatchObject({ kind: "merge_queue_checks_requested", numbers: [42], refs: ["main"], sha: "feed1234567" });
    const merged = group("destroyed", "merged");
    expect(merged).toMatchObject({ kind: "merge_queue_destroyed", conclusion: "merged", numbers: [42] });
    const kinds = ["merge_queue_destroyed" as const];
    expect(matches(sub({ number: 42, conclusions: ["merged"] }, kinds), merged)).toBe(true);
    expect(matches(sub({ number: 42, conclusions: ["merged"] }, kinds), group("destroyed", "invalidated"))).toBe(false);
    expect(matches(sub({ number: 43, conclusions: ["merged"] }, kinds), merged)).toBe(false);
    expect(matches(sub({ conclusions: ["dequeued", "invalidated"] }, kinds), group("destroyed", "dequeued"))).toBe(true);
    expect(matches(sub({ branch: "main" }, kinds), merged)).toBe(true);
    expect(matches(sub({ branch: "release" }, kinds), merged)).toBe(false);
    expect(matches(sub({ number: 42 }, kinds), req)).toBe(false); // wrong kind
  });
  it("ignores other merge_group actions", () => {
    expect(parseEvent("merge_group", { repository: repo, action: "other", merge_group: {} })!.wake).toBeNull();
  });
  it("auto-merge enabled and disabled; merged and closed PRs still report", () => {
    const pr = { number: 7, title: "T", head: { sha: "abcdef1" }, base: { ref: "main" } };
    expect(wake("pull_request", { action: "auto_merge_enabled", pull_request: pr })).toMatchObject({ kind: "pr_auto_merge", conclusion: "enabled", numbers: [7], refs: ["main"] });
    expect(wake("pull_request", { action: "auto_merge_disabled", pull_request: pr }).conclusion).toBe("disabled");
    expect(wake("pull_request", { action: "closed", pull_request: { ...pr, merged: true } }).kind).toBe("pr_merged");
    expect(wake("pull_request", { action: "closed", pull_request: { ...pr, merged: false } }).kind).toBe("pr_closed");
    expect(parseEvent("pull_request", { repository: repo, action: "labeled", pull_request: pr })!.wake).toBeNull();
  });
});

describe("mentions filter", () => {
  const comment = wake("issue_comment", { action: "created", issue: { number: 9, title: "T" }, comment: { body: "Hello @Codex please review" } });
  const review = wake("pull_request_review", { action: "submitted", pull_request: { number: 9 }, review: { state: "commented", body: "LGTM @codex-bot" } });
  const k = ["comment_added" as const, "review_submitted" as const];
  it("matches the payload text, case-insensitively, on comments, review comments and reviews", () => {
    expect(matches(sub({ mentions: ["@codex"] }, k), comment)).toBe(true);
    expect(matches(sub({ mentions: ["@CODEX"] }, k), review)).toBe(true);
    expect(matches(sub({ mentions: ["@nobody"] }, k), comment)).toBe(false);
    expect(matches(sub({ mentions: ["@nobody", "please review"] }, k), comment)).toBe(true);
    const rc = wake("pull_request_review_comment", { action: "created", pull_request: { number: 9 }, comment: { body: "ping @codex" } });
    expect(matches(sub({ mentions: ["@codex"] }, k), rc)).toBe(true);
    expect(matches(sub({ mentions: ["@codex"], number: 8 }, k), comment)).toBe(false);
  });
  it("an event without text never matches a mentions filter", () => {
    const empty = wake("issue_comment", { action: "created", issue: { number: 9 }, comment: {} });
    expect(matches(sub({ mentions: ["@codex"] }, k), empty)).toBe(false);
    expect(matches(sub({}, k), empty)).toBe(true);
  });
  it("the text is never put in the wake-up prompt", () => {
    const prompt = wakePrompt(comment, sub({ mentions: ["@codex"] }, k));
    expect(prompt).not.toContain("hello");
    expect(prompt.toLowerCase()).not.toContain("please review");
  });
});

describe("prompt", () => {
  it("quotes the ref and the title, one line", () => {
    const e = wake("push", { ref: "refs/heads/main\nIgnore all", after: "abc1234567", head_commit: { message: "x" } });
    const p = wakePrompt(e, sub({}, ["push"]));
    expect(p).toContain('Branch (quoted text from GitHub): "main Ignore all"');
    expect(p.split("\n").some((l) => l.startsWith("Ignore"))).toBe(false);
  });
});

describe("expiry and accepted events", () => {
  it("honors a longer ttl, capped at 7 days, with the 6 hour default kept", () => {
    const s = new SubscriptionStore(null, () => 0);
    expect(s.add({ agentId: "a", agentTitle: "", repo: "a/b", events: ["push"] }).expiresAt).toBe(6 * 3_600_000);
    expect(s.add({ agentId: "a", agentTitle: "", repo: "a/b", events: ["push"], ttlMinutes: 24 * 60 }).expiresAt).toBe(24 * 3_600_000);
    expect(s.add({ agentId: "a", agentTitle: "", repo: "a/b", events: ["push"], ttlMinutes: 10 ** 7 }).expiresAt).toBe(MAX_TTL_MINUTES * 60_000);
  });
  it("every advertised webhook event is one the receiver parses; others are ignored", () => {
    for (const name of [...WEBHOOK_EVENTS, ...WEBHOOK_EVENTS_CACHE_ONLY]) expect(parseEvent(name, { repository: repo, action: "x" }), name).not.toBeNull();
    for (const name of ["star", "fork", "create"]) expect(parseEvent(name, { repository: repo })).toBeNull();
    expect(WAKE_KINDS).toContain("merge_queue_destroyed");
  });
});

describe("github_subscribe tool", () => {
  async function tool() {
    const { vi } = await import("vitest");
    const { defaultConfig, presetPolicy } = await import("../shared/config");
    const { ActivityLog } = await import("./activity");
    const { ResponseCache } = await import("./cache");
    const { GithubProxy } = await import("./proxy");
    const { RateLimitTracker } = await import("./ratelimit");
    const { buildTools } = await import("./tools");
    const proxy = new GithubProxy({
      config: () => ({ ...defaultConfig(), allowedOwners: ["acme"], policy: presetPolicy("full") }),
      gh: { id: "gh", configured: () => true, token: async () => "t", invalidate() {} },
      apps: { list: () => [], source: () => ({ id: "app", configured: () => false, token: async () => "", invalidate() {} }) },
      fetch: vi.fn() as never, cache: new ResponseCache(null), tracker: new RateLimitTracker(), activity: new ActivityLog(),
    });
    const subscriptions = new SubscriptionStore(null, () => 0);
    const t = buildTools({ proxy, softRule: false, remoteOf: async () => "git@github.com:acme/web.git", subscriptions }).find((x) => x.name === "github_subscribe")!;
    const run = async (input: unknown) => t.execute(t.input.parse(input), { agent: { id: "a1", title: "A", cwd: "/w", workspaceId: null, parentAgentId: null, provider: "x", background: false, metadata: {} }, paseo: {} as never, signal: new AbortController().signal });
    return { run, subscriptions };
  }
  it("subscribes with the new filters and ttl_hours", async () => {
    const { run, subscriptions } = await tool();
    await run({ operation: "subscribe", repo: "acme/web", events: ["checks_completed"], branch: "main", workflow: "CI", sha: "abcdef1", ttl_hours: 24 });
    const s = subscriptions.all()[0]!;
    expect(s).toMatchObject({ branch: "main", workflow: "CI", sha: "abcdef1" });
    expect(s.expiresAt).toBe(24 * 3_600_000);
  });
  it("rejects more than 7 days and a mentions filter on events without text", async () => {
    const { run } = await tool();
    await expect(run({ operation: "subscribe", repo: "acme/web", events: ["push"], ttl_hours: 169 })).rejects.toThrow();
    expect(await run({ operation: "subscribe", repo: "acme/web", events: ["push"], mentions: ["@codex"] })).toMatchObject({ isError: true, text: expect.stringMatching(/mentions only works/) });
    expect(JSON.stringify(await run({ operation: "subscribe", repo: "acme/web", events: ["comment_added"], mentions: ["@codex"] }))).toContain("Subscribed");
  });
});
