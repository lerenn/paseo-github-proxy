import { describe, expect, it, vi } from "vitest";
import { defaultConfig, presetPolicy, type Config } from "../shared/config";
import { ActivityLog } from "./activity";
import type { FetchFn } from "./auth";
import { ResponseCache } from "./cache";
import { GithubProxy } from "./proxy";
import { RateLimitTracker } from "./ratelimit";
import { buildTools } from "./tools";

type Reply = { status?: number; body?: unknown; text?: string };

function make(config: Partial<Config>, replies: Reply[] = []) {
  const cfg: Config = { ...defaultConfig(), allowedOwners: ["acme"], ...config };
  const queue = [...replies];
  const calls: { url: string; method: string; body?: string; accept?: string }[] = [];
  const fetchFn: FetchFn = vi.fn(async (url, init) => {
    calls.push({ url, method: init.method, ...(init.body ? { body: init.body } : {}), ...(init.headers.Accept !== "application/vnd.github+json" ? { accept: init.headers.Accept } : {}) });
    const r = queue.shift() ?? {};
    const type = r.text !== undefined ? "text/plain" : "application/json";
    return { status: r.status ?? 200, headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? type : null) }, text: async () => (r.text !== undefined ? r.text : JSON.stringify(r.body ?? {})) };
  });
  const proxy = new GithubProxy({
    config: () => cfg,
    gh: { id: "gh", configured: () => true, token: async () => "t", invalidate() {} },
    apps: { list: () => [], source: () => ({ id: "app", configured: () => false, token: async () => "", invalidate() {} }) },
    fetch: fetchFn, cache: new ResponseCache(null), tracker: new RateLimitTracker(), activity: new ActivityLog(),
  });
  const tools = buildTools({ proxy, softRule: false, remoteOf: async () => "git@github.com:acme/web.git" });
  const run = async (name: string, input: unknown) => {
    const tool = tools.find((t) => t.name === name)!;
    return tool.execute(tool.input.parse(input), { agent: { id: "a1", title: "A", cwd: "/w", workspaceId: null, parentAgentId: null, provider: "x", background: false, metadata: {} }, paseo: {} as never, signal: new AbortController().signal });
  };
  return { run, calls, proxy };
}

const full = { policy: presetPolicy("full") };
const R = "https://api.github.com/repos/acme/web";
const gqlBody = (call: { body?: string }) => JSON.parse(call.body!) as { query: string; variables: any };

describe("every write operation is denied under the read-only default, and nothing is written", () => {
  const writes: [string, Record<string, unknown>][] = [
    ["github_contents", { operation: "write", path: "a.txt", content: "x", message: "m" }],
    ["github_contents", { operation: "delete", path: "a.txt", sha: "1", message: "m" }],
    ["github_contents", { operation: "create_branch", branch: "b", from: "0".repeat(40) }],
    ["github_update_issue", { number: 1, title: "t" }],
    ["github_update_issue", { number: 1, add_labels: ["x"] }],
    ["github_pr_manage", { operation: "ready", number: 1 }],
    ["github_pr_manage", { operation: "auto_merge", number: 1 }],
    ["github_pr_manage", { operation: "request_reviewers", number: 1, reviewers: ["bob"] }],
    ["github_pr_manage", { operation: "reply", number: 1, comment_id: 2, body: "x" }],
    ["github_edit_comment", { kind: "issue", comment_id: 1, operation: "delete" }],
    ["github_releases", { operation: "create", tag_name: "v1" }],
    ["github_releases", { operation: "delete", release_id: 1 }],
    ["github_actions", { operation: "rerun", run_id: 1 }],
    ["github_actions", { operation: "dispatch", workflow: "ci.yml", ref: "main" }],
    ["github_actions", { operation: "delete_cache", cache_id: 1 }],
    ["github_labels", { operation: "create", name: "x" }],
    ["github_repo_manage", { operation: "edit", description: "d" }],
    ["github_repo_manage", { operation: "fork" }],
    ["github_repo_manage", { operation: "sync_fork", branch: "main" }],
    ["github_repo_config", { operation: "set_variable", name: "A", value: "1" }],
    ["github_repo_config", { operation: "delete_secret", name: "A" }],
    ["github_account", { operation: "mark_read" }],
    ["github_gists", { operation: "create", files: { "a.txt": "x" } }],
    ["github_project", { operation: "add_item", owner: "acme", number: 1, repo: "acme/web", issue_number: 1 }],
  ];
  for (const [name, input] of writes) {
    it(`${name} ${String(input.operation ?? "")}`, async () => {
      const any = { body: { node_id: "N", default_branch: "main", data: { owner: { projectV2: { id: "P", fields: { nodes: [] } } } } } };
      const t = make({}, [any, any, any]);
      const r = await t.run(name, input);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Do not retry/);
      expect(t.calls.every((c) => c.method === "GET" || c.url.endsWith("/graphql"))).toBe(true);
      expect(t.calls.filter((c) => c.url.endsWith("/graphql")).every((c) => !/mutation/.test(gqlBody(c).query))).toBe(true);
    });
  }
});

describe("commits and contents", () => {
  it("lists, gets (with the raw diff) and compares", async () => {
    const t = make({}, [{ body: [{ sha: "abc", commit: { message: "fix\n\nbody", author: { name: "A", date: "d" } }, html_url: "u" }] }, { text: "diff --git a b" }, { body: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, commits: [], files: [{ filename: "f", status: "modified", additions: 1, deletions: 0, patch: "@@" }] } }]);
    expect((await t.run("github_commits", { operation: "list", ref: "main", path: "src" })).text).toContain('"message": "fix"');
    expect(t.calls[0]!.url).toBe(`${R}/commits?sha=main&path=src&per_page=30`);
    expect((await t.run("github_commits", { operation: "get", ref: "abc", diff: true })).text).toBe("diff --git a b");
    expect(t.calls[1]).toMatchObject({ url: `${R}/commits/abc`, accept: "application/vnd.github.diff" });
    expect((await t.run("github_commits", { operation: "compare", base: "main", head: "feat/x" })).text).toContain('"ahead_by": 1');
    expect(t.calls[2]!.url).toContain(`${R}/compare/main...feat/x`.replace("feat/x", "feat/x"));
    expect((await t.run("github_commits", { operation: "compare", base: "a" })).text).toMatch(/needs head/);
  });

  it("the diff and the JSON of one URL are cached apart", async () => {
    const t = make({}, [{ body: { number: 1, title: "T" } }, { text: "diff --git" }]);
    await t.run("github_get_pr", { number: 1 });
    const r = await t.run("github_get_pr", { number: 1, include: ["diff"] });
    expect(r.text).toContain("diff --git");
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]!.accept).toBe("application/vnd.github.diff");
  });

  it("reads a file and a directory, decoding base64", async () => {
    const t = make({}, [{ body: { type: "file", path: "a.md", sha: "s", size: 2, encoding: "base64", content: Buffer.from("hi").toString("base64") } }, { body: [{ name: "a.md", path: "a.md", type: "file", size: 2, sha: "s" }] }, { body: { default_branch: "main" } }, { body: { truncated: false, tree: [{ type: "blob", path: "a.md" }, { type: "tree", path: "d" }] } }]);
    expect((await t.run("github_contents", { operation: "read", path: "a.md", ref: "main" })).text).toContain('"content": "hi"');
    expect(t.calls[0]!.url).toBe(`${R}/contents/a.md?ref=main`);
    expect((await t.run("github_contents", { operation: "read" })).text).toContain('"type": "file"');
    expect((await t.run("github_contents", { operation: "tree" })).text).toContain('"a.md"');
    expect(t.calls[3]!.url).toBe(`${R}/git/trees/main?recursive=1`);
  });

  it("writes, deletes and branches with the declared actions", async () => {
    const t = make(full, [{ status: 201, body: { content: { path: "a.txt", sha: "n" }, commit: { sha: "c", html_url: "u" } } }, { body: { commit: { sha: "d" } } }, { body: { default_branch: "main" } }, { body: { object: { sha: "9".repeat(40) } } }, { status: 201, body: {} }]);
    await t.run("github_contents", { operation: "write", path: "dir/a.txt", content: "hello", message: "add", branch: "b" });
    expect(t.calls[0]).toMatchObject({ method: "PUT", url: `${R}/contents/dir/a.txt` });
    expect(JSON.parse(t.calls[0]!.body!)).toEqual({ message: "add", content: Buffer.from("hello").toString("base64"), branch: "b" });
    await t.run("github_contents", { operation: "delete", path: "a.txt", sha: "s", message: "rm" });
    expect(t.calls[1]).toMatchObject({ method: "DELETE" });
    const r = await t.run("github_contents", { operation: "create_branch", branch: "new" });
    expect(r.text).toContain("Created branch new");
    expect(t.calls[3]!.url).toBe(`${R}/git/ref/heads/main`);
    expect(t.calls[4]).toMatchObject({ method: "POST", url: `${R}/git/refs` });
    expect(JSON.parse(t.calls[4]!.body!)).toEqual({ ref: "refs/heads/new", sha: "9".repeat(40) });
  });

  it("write_file can be denied alone while the PR workflow preset allows branches", async () => {
    const t = make({ policy: presetPolicy("pr_workflow") }, [{ body: { default_branch: "main" } }, { body: { object: { sha: "1" } } }, { body: {} }]);
    expect((await t.run("github_contents", { operation: "write", path: "a", content: "x", message: "m" })).text).toMatch(/Write file.*not allowed/);
    expect((await t.run("github_contents", { operation: "create_branch", branch: "n" })).isError).toBeUndefined();
  });
});

describe("issues and pull requests", () => {
  it("github_update_issue makes one call per part", async () => {
    const t = make({ policy: presetPolicy("pr_workflow") });
    const r = await t.run("github_update_issue", { number: 7, state: "closed", state_reason: "not_planned", add_labels: ["bug"], remove_labels: ["a b"], add_assignees: ["bob"], remove_assignees: ["al"], lock: "lock", lock_reason: "resolved" });
    expect(r.isError).toBeUndefined();
    expect(t.calls.map((c) => `${c.method} ${c.url.replace(R, "")}`)).toEqual(["PATCH /issues/7", "POST /issues/7/labels", "DELETE /issues/7/labels/a%20b", "POST /issues/7/assignees", "DELETE /issues/7/assignees", "PUT /issues/7/lock"]);
    expect(JSON.parse(t.calls[0]!.body!)).toEqual({ state: "closed", state_reason: "not_planned" });
    expect((await t.run("github_update_issue", { number: 7 })).text).toMatch(/Nothing to change/);
  });

  it("marks a PR ready through GraphQL with the node id of the PR", async () => {
    const t = make({ policy: presetPolicy("pr_workflow") }, [{ body: { node_id: "PR_1" } }, { body: { data: { markPullRequestReadyForReview: { pullRequest: { number: 3, isDraft: false } } } } }]);
    const r = await t.run("github_pr_manage", { operation: "ready", number: 3 });
    expect(r.text).toContain('"isDraft": false');
    expect(gqlBody(t.calls[1]!).query).toContain("markPullRequestReadyForReview");
    expect(gqlBody(t.calls[1]!).variables).toEqual({ input: { pullRequestId: "PR_1" } });
  });

  it("auto-merge needs the merge action; pr_workflow does not have it", async () => {
    const denied = make({ policy: presetPolicy("pr_workflow") }, [{ body: { node_id: "PR_1" } }]);
    expect((await denied.run("github_pr_manage", { operation: "auto_merge", number: 3 })).text).toMatch(/"Merge" is not allowed/);
    const ok = make(full, [{ body: { node_id: "PR_1" } }, { body: { data: { enablePullRequestAutoMerge: { pullRequest: { number: 3 } } } } }]);
    await ok.run("github_pr_manage", { operation: "auto_merge", number: 3, merge_method: "squash" });
    expect(gqlBody(ok.calls[1]!).variables.input).toEqual({ pullRequestId: "PR_1", mergeMethod: "SQUASH" });
  });

  it("requests reviewers, updates the branch and replies to a review comment", async () => {
    const t = make({ policy: presetPolicy("pr_workflow") }, [{ body: { requested_reviewers: [{ login: "bob" }], requested_teams: [] } }, { status: 202, body: { message: "Updating" } }, { status: 201, body: { html_url: "u" } }, { body: {} }]);
    expect((await t.run("github_pr_manage", { operation: "request_reviewers", number: 2, reviewers: ["bob"] })).text).toContain("bob");
    expect(t.calls[0]).toMatchObject({ method: "POST", url: `${R}/pulls/2/requested_reviewers` });
    await t.run("github_pr_manage", { operation: "update_branch", number: 2, sha: "abc" });
    expect(t.calls[1]).toMatchObject({ method: "PUT", url: `${R}/pulls/2/update-branch`, body: '{"expected_head_sha":"abc"}' });
    await t.run("github_pr_manage", { operation: "reply", number: 2, comment_id: 55, body: "done" });
    expect(t.calls[2]).toMatchObject({ method: "POST", url: `${R}/pulls/2/comments/55/replies` });
    expect((await t.run("github_pr_manage", { operation: "request_reviewers", number: 2 })).text).toMatch(/needs reviewers/);
  });

  it("resolves a thread only when it belongs to that pull request", async () => {
    const t = make({ policy: presetPolicy("pr_workflow") }, [
      { body: { data: { node: { pullRequest: { number: 9, repository: { nameWithOwner: "other/repo" } } } } } },
      { body: { data: { node: { pullRequest: { number: 2, repository: { nameWithOwner: "Acme/web" } } } } } },
      { body: { data: { resolveReviewThread: { thread: { id: "T", isResolved: true } } } } },
    ]);
    const bad = await t.run("github_pr_manage", { operation: "resolve_thread", number: 2, thread_id: "T" });
    expect(bad.text).toMatch(/not a review thread of acme\/web#2/);
    const ok = await t.run("github_pr_manage", { operation: "resolve_thread", number: 2, thread_id: "T2" });
    expect(ok.text).toContain('"isResolved": true');
    expect(gqlBody(t.calls[2]!).query).toContain("resolveReviewThread");
  });

  it("github_get_pr lists review threads and commits", async () => {
    const t = make({}, [{ body: { number: 1, title: "T" } }, { body: [{ sha: "s", commit: { message: "m\nx" }, author: { login: "bob" } }] }, { body: { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "T1", isResolved: false, path: "a", line: 3, comments: { nodes: [{ databaseId: 5, author: { login: "bob" }, body: "fix" }] } }] } } } } } }]);
    const r = await t.run("github_get_pr", { number: 1, include: ["commits", "threads"] });
    expect(r.text).toContain('"id": "T1"');
    expect(r.text).toContain('"message": "m"');
  });

  it("edits and deletes comments", async () => {
    const t = make({ policy: presetPolicy("pr_workflow") }, [{ body: { html_url: "u" } }, {}]);
    await t.run("github_edit_comment", { kind: "issue", comment_id: 4, operation: "edit", body: "new" });
    expect(t.calls[0]).toMatchObject({ method: "PATCH", url: `${R}/issues/comments/4` });
    await t.run("github_edit_comment", { kind: "review", comment_id: 5, operation: "delete" });
    expect(t.calls[1]).toMatchObject({ method: "DELETE", url: `${R}/pulls/comments/5` });
  });

  it("search passes sort and order", async () => {
    const t = make({}, [{ body: { total_count: 0, items: [] } }]);
    await t.run("github_search", { query: "x", repo: "acme/web", sort: "updated", order: "desc" });
    const u = new URL(t.calls[0]!.url);
    expect([u.searchParams.get("sort"), u.searchParams.get("order")]).toEqual(["updated", "desc"]);
  });

  it("github_repo_info can add the README and languages", async () => {
    const t = make({}, [{ body: { full_name: "acme/web", topics: ["a"] } }, { body: { TypeScript: 10 } }, { body: { path: "README.md", content: Buffer.from("# Hi").toString("base64") } }]);
    const r = await t.run("github_repo_info", { include: ["languages", "readme"] });
    expect(r.text).toContain('"TypeScript": 10');
    expect(r.text).toContain("# Hi");
  });
});

describe("releases", () => {
  it("lists, gets the latest or a tag, creates, edits by tag and deletes", async () => {
    const t = make(full, [
      { body: [{ id: 1, tag_name: "v1", name: "One" }] },
      { body: { id: 2, tag_name: "v2", body: "notes", assets: [{ id: 9, name: "a.zip", size: 3, download_count: 1, browser_download_url: "u" }] } },
      { body: { id: 1, tag_name: "v1" } },
      { status: 201, body: { id: 3, tag_name: "v3" } },
      { body: { id: 1 } },
      { body: { id: 1, tag_name: "v1", name: "New" } },
      {},
      {},
    ]);
    expect((await t.run("github_releases", { operation: "list" })).text).toContain('"tag": "v1"');
    expect((await t.run("github_releases", { operation: "get" })).text).toContain('"name": "a.zip"');
    expect(t.calls[1]!.url).toBe(`${R}/releases/latest`);
    await t.run("github_releases", { operation: "get", tag: "v1" });
    expect(t.calls[2]!.url).toBe(`${R}/releases/tags/v1`);
    await t.run("github_releases", { operation: "create", tag_name: "v3", generate_notes: true, draft: true });
    expect(JSON.parse(t.calls[3]!.body!)).toEqual({ tag_name: "v3", draft: true, generate_release_notes: true });
    await t.run("github_releases", { operation: "edit", tag: "v1", name: "New" });
    expect(t.calls[5]).toMatchObject({ method: "PATCH", url: `${R}/releases/1` });
    await t.run("github_releases", { operation: "delete", release_id: 1 });
    expect(t.calls[6]).toMatchObject({ method: "DELETE", url: `${R}/releases/1` });
    await t.run("github_releases", { operation: "delete_asset", asset_id: 9 });
    expect(t.calls[7]).toMatchObject({ method: "DELETE", url: `${R}/releases/assets/9` });
  });

  it("a deny rule on manage_release protects a repo under the full preset", async () => {
    const policy = presetPolicy("full", [{ id: "r", effect: "deny", repos: ["acme/web"], actions: ["manage_release"], reason: "humans release" }]);
    const t = make({ policy });
    const r = await t.run("github_releases", { operation: "create", tag_name: "v1" });
    expect(r.text).toMatch(/humans release.*Do not retry/);
    expect(t.calls).toHaveLength(0);
  });
});

describe("actions", () => {
  it("reads workflows, runs and one run with its jobs", async () => {
    const t = make({}, [{ body: { workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" }] } }, { body: { total_count: 1, workflow_runs: [{ id: 5, name: "CI", status: "completed", conclusion: "failure", head_branch: "main" }] } }, { body: { id: 5, conclusion: "failure" } }, { body: { jobs: [{ id: 8, name: "test", conclusion: "failure", steps: [{ name: "s", conclusion: "failure" }] }] } }]);
    expect((await t.run("github_actions", { operation: "list_workflows" })).text).toContain("ci.yml");
    await t.run("github_actions", { operation: "list_runs", workflow: "ci.yml", branch: "main", status: "failure" });
    expect(t.calls[1]!.url).toBe(`${R}/actions/workflows/ci.yml/runs?branch=main&status=failure&per_page=30`);
    expect((await t.run("github_actions", { operation: "get_run", run_id: 5 })).text).toContain('"name": "test"');
  });

  it("returns the end of the logs of the failed jobs", async () => {
    const log = Array.from({ length: 300 }, (_, n) => `line ${n}`).join("\n");
    const t = make({}, [{ body: { jobs: [{ id: 8, name: "test", conclusion: "failure" }, { id: 9, name: "lint", conclusion: "success" }] } }, { text: log }, { text: log }]);
    const r = await t.run("github_actions", { operation: "job_logs", run_id: 5, tail_lines: 3 });
    expect(r.text).toContain("job 8: test");
    expect(r.text).toContain("line 299");
    expect(r.text).not.toContain("line 10\n");
    expect(r.text).not.toContain("lint");
    const direct = await t.run("github_actions", { operation: "job_logs", job_id: 8, tail_lines: 2 });
    expect(direct.text).toBe("line 298\nline 299");
    expect(t.calls[1]!.url).toBe(`${R}/actions/jobs/8/logs`);
    const none = make({}, [{ body: { jobs: [{ id: 1, conclusion: "success" }] } }]);
    expect((await none.run("github_actions", { operation: "job_logs", run_id: 5 })).text).toMatch(/no failed job/);
  });

  it("re-runs, cancels, dispatches, toggles and deletes", async () => {
    const t = make(full);
    await t.run("github_actions", { operation: "rerun", run_id: 5, failed_only: true });
    await t.run("github_actions", { operation: "rerun", job_id: 8 });
    await t.run("github_actions", { operation: "cancel", run_id: 5 });
    await t.run("github_actions", { operation: "dispatch", workflow: "ci.yml", ref: "main", inputs: { a: "1" } });
    await t.run("github_actions", { operation: "disable", workflow: "ci.yml" });
    await t.run("github_actions", { operation: "delete_run", run_id: 5 });
    await t.run("github_actions", { operation: "delete_cache", key: "npm-1" });
    expect(t.calls.map((c) => `${c.method} ${c.url.replace(`${R}/actions`, "")}`)).toEqual([
      "POST /runs/5/rerun-failed-jobs", "POST /jobs/8/rerun", "POST /runs/5/cancel", "POST /workflows/ci.yml/dispatches", "PUT /workflows/ci.yml/disable", "DELETE /runs/5", "DELETE /caches?key=npm-1",
    ]);
    expect(JSON.parse(t.calls[3]!.body!)).toEqual({ ref: "main", inputs: { a: "1" } });
  });

  it("lists artifacts and caches", async () => {
    const t = make({}, [{ body: { artifacts: [{ id: 1, name: "dist", size_in_bytes: 4, expired: false }] } }, { body: { total_count: 1, actions_caches: [{ id: 2, key: "k", ref: "main", size_in_bytes: 1 }] } }]);
    expect((await t.run("github_actions", { operation: "list_artifacts", run_id: 5 })).text).toContain('"name": "dist"');
    expect(t.calls[0]!.url).toContain("/actions/runs/5/artifacts");
    expect((await t.run("github_actions", { operation: "list_caches" })).text).toContain('"key": "k"');
  });
});

describe("labels", () => {
  it("lists, creates, edits and deletes", async () => {
    const t = make({ policy: presetPolicy("pr_workflow") }, [{ body: [{ name: "bug", color: "f00" }] }, { status: 201, body: { name: "x", color: "00ff00" } }, { body: { name: "y" } }, {}]);
    expect((await t.run("github_labels", { operation: "list" })).text).toContain('"bug"');
    await t.run("github_labels", { operation: "create", name: "x", color: "#00ff00", description: "d" });
    expect(JSON.parse(t.calls[1]!.body!)).toEqual({ name: "x", color: "00ff00", description: "d" });
    await t.run("github_labels", { operation: "edit", name: "x", new_name: "y" });
    expect(t.calls[2]).toMatchObject({ method: "PATCH", url: `${R}/labels/x`, body: '{"new_name":"y"}' });
    await t.run("github_labels", { operation: "delete", name: "a b" });
    expect(t.calls[3]).toMatchObject({ method: "DELETE", url: `${R}/labels/a%20b` });
  });
});

describe("repository management", () => {
  it("creates in an organization, and refuses an owner the policy does not allow", async () => {
    const t = make({ ...full, allowedOwners: ["acme"] }, [{ status: 201, body: { full_name: "acme/new", private: true } }]);
    await t.run("github_repo_manage", { operation: "create", name: "new", owner: "acme", description: "d" });
    expect(t.calls[0]).toMatchObject({ method: "POST", url: "https://api.github.com/orgs/acme/repos" });
    expect(JSON.parse(t.calls[0]!.body!)).toEqual({ name: "new", description: "d", private: true });
    const other = await t.run("github_repo_manage", { operation: "create", name: "new", owner: "evil" });
    expect(other.text).toMatch(/Do not retry/);
    expect(t.calls).toHaveLength(1);
    const user = make({ ...full, allowedOwners: ["acme"] });
    expect((await user.run("github_repo_manage", { operation: "create", name: "mine" })).text).toMatch(/not scoped to an owner|Do not retry/);
    expect(user.calls).toHaveLength(0);
    const wild = make({ ...full, allowedOwners: ["*"] }, [{ body: {} }]);
    await wild.run("github_repo_manage", { operation: "create", name: "mine", private: false });
    expect(wild.calls[0]!.url).toBe("https://api.github.com/user/repos");
  });

  it("forks (checking the destination), edits, sets topics and syncs a fork", async () => {
    const t = make(full, [{ status: 202, body: { full_name: "acme/web2", fork: true } }, { body: { full_name: "acme/web" } }, { body: { names: ["a"] } }, { body: { merge_type: "fast-forward" } }]);
    await t.run("github_repo_manage", { operation: "fork", organization: "acme", name: "web2" });
    expect(t.calls[0]).toMatchObject({ url: `${R}/forks` });
    const evil = await t.run("github_repo_manage", { operation: "fork", organization: "evil" });
    expect(evil.text).toMatch(/Do not retry/);
    expect(t.calls).toHaveLength(1);
    const r = await t.run("github_repo_manage", { operation: "edit", description: "d", topics: ["a"] });
    expect(r.text).toContain('"topics"');
    expect(t.calls[1]).toMatchObject({ method: "PATCH", url: R });
    expect(t.calls[2]).toMatchObject({ method: "PUT", url: `${R}/topics`, body: '{"names":["a"]}' });
    await t.run("github_repo_manage", { operation: "sync_fork", branch: "main" });
    expect(t.calls[3]).toMatchObject({ method: "POST", url: `${R}/merge-upstream` });
    expect((await t.run("github_repo_manage", { operation: "edit" })).text).toMatch(/Nothing to change/);
  });
});

describe("repository settings", () => {
  it("reads rulesets, protection, environments and deploy keys", async () => {
    const t = make({}, [{ body: [{ id: 1, name: "main", target: "branch", enforcement: "active" }] }, { body: { id: 1, rules: [] } }, { body: [{ type: "pull_request" }] }, { body: { required_status_checks: {} } }, { body: { environments: [{ name: "prod", protection_rules: [{ type: "required_reviewers" }] }] } }, { body: [{ id: 1, title: "ci", read_only: true, key: "ssh-rsa AAA" }] }]);
    expect((await t.run("github_repo_config", { operation: "rulesets" })).text).toContain('"enforcement": "active"');
    await t.run("github_repo_config", { operation: "ruleset", ruleset_id: 1 });
    expect(t.calls[1]!.url).toBe(`${R}/rulesets/1`);
    await t.run("github_repo_config", { operation: "branch_rules", branch: "feat/x" });
    expect(t.calls[2]!.url).toContain(`${R}/rules/branches/feat/x`);
    await t.run("github_repo_config", { operation: "branch_protection", branch: "main" });
    expect(t.calls[3]!.url).toBe(`${R}/branches/main/protection`);
    expect((await t.run("github_repo_config", { operation: "environments" })).text).toContain("required_reviewers");
    const keys = await t.run("github_repo_config", { operation: "deploy_keys" });
    expect(keys.text).toContain('"title": "ci"');
    expect(keys.text).not.toContain("ssh-rsa");
  });

  it("lists secret names without anything else, and variables with values", async () => {
    const t = make({}, [{ body: { total_count: 1, secrets: [{ name: "TOKEN", created_at: "c", updated_at: "u", value: "leak", encrypted_value: "leak" }] } }, { body: { total_count: 1, variables: [{ name: "A", value: "1", updated_at: "u" }] } }, { body: { total_count: 0, secrets: [] } }]);
    const s = await t.run("github_repo_config", { operation: "secrets" });
    expect(s.text).toContain("TOKEN");
    expect(s.text).not.toContain("leak");
    expect((await t.run("github_repo_config", { operation: "variables" })).text).toContain('"value": "1"');
    await t.run("github_repo_config", { operation: "secrets", org: "acme" });
    expect(t.calls[2]!.url).toBe("https://api.github.com/orgs/acme/actions/secrets?per_page=30");
  });

  it("sets a variable (creating, then updating on conflict) and deletes variables and secrets", async () => {
    const t = make(full, [{ status: 409, body: { message: "Already exists" } }, {}, {}, {}, { status: 201 }]);
    expect((await t.run("github_repo_config", { operation: "set_variable", name: "A", value: "2" })).text).toBe("Updated variable A.");
    expect(t.calls.map((c) => `${c.method} ${c.url.replace(R, "")}`)).toEqual(["POST /actions/variables", "PATCH /actions/variables/A"]);
    await t.run("github_repo_config", { operation: "delete_variable", name: "A", environment: "prod" });
    expect(t.calls[2]).toMatchObject({ method: "DELETE", url: `${R}/environments/prod/variables/A` });
    await t.run("github_repo_config", { operation: "delete_secret", name: "S", org: "acme" });
    expect(t.calls[3]).toMatchObject({ method: "DELETE", url: "https://api.github.com/orgs/acme/actions/secrets/S" });
    await t.run("github_repo_config", { operation: "set_variable", name: "O", value: "1", org: "acme" });
    expect(JSON.parse(t.calls[4]!.body!)).toEqual({ name: "O", value: "1", visibility: "private" });
  });
});

describe("account, notifications and gists", () => {
  const wild = { allowedOwners: ["*"] };
  it("reads users, orgs and repositories (falling back from org to user)", async () => {
    const t = make({}, [{ body: { login: "bob", type: "User" } }, { body: { login: "acme", description: "d" } }, { status: 404, body: {} }, { body: [{ full_name: "bob/x" }] }, { body: [{ login: "al" }] }, { body: [{ slug: "core", name: "Core" }] }]);
    expect((await t.run("github_account", { operation: "user", owner: "acme" })).text).toContain("bob");
    await t.run("github_account", { operation: "org", owner: "acme" });
    expect((await t.run("github_account", { operation: "list_repos", owner: "acme" })).text).toContain("bob/x");
    expect(t.calls.slice(2).map((c) => c.url)).toEqual(["https://api.github.com/orgs/acme/repos?per_page=30", "https://api.github.com/users/acme/repos?per_page=30"]);
    expect((await t.run("github_account", { operation: "org_members", owner: "acme" })).text).toContain("al");
    expect((await t.run("github_account", { operation: "org_teams", owner: "acme" })).text).toContain("core");
  });

  it("account level reads need the * owner; with it they work", async () => {
    const restricted = make({}, []);
    for (const operation of ["my_orgs", "notifications"]) {
      const r = await restricted.run("github_account", { operation });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Do not retry/);
    }
    expect(restricted.calls).toHaveLength(0);
    const t = make(wild, [{ body: { login: "me" } }, { body: ["acme"].map((login) => ({ login })) }, { body: [{ id: "1", reason: "mention", unread: true, repository: { full_name: "acme/web" }, subject: { title: "T", type: "PullRequest" } }] }, { body: [] }]);
    expect((await t.run("github_account", { operation: "me" })).text).toContain('"login": "me"');
    await t.run("github_account", { operation: "my_orgs" });
    expect((await t.run("github_account", { operation: "notifications", participating: true })).text).toContain('"reason": "mention"');
    expect(t.calls[2]!.url).toBe("https://api.github.com/notifications?participating=true&per_page=30");
    await t.run("github_account", { operation: "notifications", repo: "acme/web", all: true });
    expect(t.calls[3]!.url).toBe(`${R}/notifications?all=true&per_page=30`);
  });

  it("marks notifications read under Manage notifications", async () => {
    const t = make({ ...wild, policy: presetPolicy("pr_workflow") }, [{}, {}]);
    await t.run("github_account", { operation: "mark_read", thread_id: "7" });
    expect(t.calls[0]).toMatchObject({ method: "PATCH", url: "https://api.github.com/notifications/threads/7" });
    await t.run("github_account", { operation: "mark_read", repo: "acme/web" });
    expect(t.calls[1]).toMatchObject({ method: "PUT", url: `${R}/notifications` });
  });

  it("lists, reads, creates, edits and deletes gists", async () => {
    const t = make({ ...wild, ...full }, [{ body: [{ id: "g1", description: "d", files: { "a.txt": {} } }] }, { body: { id: "g1", files: { "a.txt": { content: "hi" } } } }, { status: 201, body: { id: "g2", files: {} } }, { body: { id: "g1", files: {} } }, {}]);
    expect((await t.run("github_gists", { operation: "list" })).text).toContain('"g1"');
    expect((await t.run("github_gists", { operation: "get", id: "g1" })).text).toContain('"a.txt": "hi"');
    await t.run("github_gists", { operation: "create", files: { "b.md": "x" }, description: "d" });
    expect(JSON.parse(t.calls[2]!.body!)).toEqual({ files: { "b.md": { content: "x" } }, description: "d", public: false });
    await t.run("github_gists", { operation: "edit", id: "g1", files: { "a.txt": null, "c.txt": "y" } });
    expect(JSON.parse(t.calls[3]!.body!)).toEqual({ files: { "a.txt": null, "c.txt": { content: "y" } } });
    await t.run("github_gists", { operation: "delete", id: "g1" });
    expect(t.calls[4]).toMatchObject({ method: "DELETE", url: "https://api.github.com/gists/g1" });
  });
});

describe("projects", () => {
  const project = { id: "P1", number: 3, title: "Roadmap", fields: { nodes: [{ id: "F1", name: "Status", dataType: "SINGLE_SELECT", options: [{ id: "O1", name: "Todo" }, { id: "O2", name: "Done" }] }, { id: "F2", name: "Points", dataType: "NUMBER" }] } };
  const view = { body: { data: { owner: { projectV2: project } } } };

  it("lists, views and reads items, scoped to the owner", async () => {
    const t = make({}, [{ body: { data: { owner: { projectsV2: { nodes: [{ number: 3, title: "Roadmap" }] } } } } }, view, { body: { data: { owner: { projectV2: { items: { pageInfo: { hasNextPage: true, endCursor: "c" }, nodes: [{ id: "I1", type: "ISSUE", content: { number: 1, title: "T", repository: { nameWithOwner: "acme/web" } }, fieldValues: { nodes: [{ name: "Todo", field: { name: "Status" } }, {}] } }] } } } } } }]);
    expect((await t.run("github_project", { operation: "list", owner: "acme" })).text).toContain("Roadmap");
    expect((await t.run("github_project", { operation: "view", owner: "acme", number: 3 })).text).toContain('"Done"');
    const items = JSON.parse((await t.run("github_project", { operation: "items", owner: "acme", number: 3 })).text!);
    expect(items.next).toBe("c");
    expect(items.items[0]).toMatchObject({ id: "I1", repository: "acme/web", values: { Status: "Todo" } });
    expect(gqlBody(t.calls[0]!).variables).toEqual({ login: "acme" });
    const other = await make({}).run("github_project", { operation: "list", owner: "evil" });
    expect(other.text).toMatch(/Do not retry/);
  });

  it("adds an item by the node id of the issue and sets fields", async () => {
    const t = make(full, [view, { body: { node_id: "I_1" } }, { body: { data: { addProjectV2ItemById: { item: { id: "IT1" } } } } }, view, { body: { data: {} } }, view, { body: { data: {} } }]);
    const added = await t.run("github_project", { operation: "add_item", owner: "acme", number: 3, repo: "acme/web", issue_number: 8 });
    expect(added.text).toContain("item IT1");
    expect(gqlBody(t.calls[2]!).variables).toEqual({ input: { projectId: "P1", contentId: "I_1" } });
    await t.run("github_project", { operation: "set_field", owner: "acme", number: 3, item_id: "IT1", field: "status", value: "done" });
    expect(gqlBody(t.calls[4]!).variables.input).toEqual({ projectId: "P1", itemId: "IT1", fieldId: "F1", value: { singleSelectOptionId: "O2" } });
    await t.run("github_project", { operation: "set_field", owner: "acme", number: 3, item_id: "IT1", field: "Points", value: 5 });
    expect(gqlBody(t.calls[6]!).variables.input.value).toEqual({ number: 5 });
    const bad = make(full, [view]);
    expect((await bad.run("github_project", { operation: "set_field", owner: "acme", number: 3, item_id: "IT1", field: "Status", value: "Nope" })).text).toMatch(/not an option.*Todo, Done/);
  });

  it("a write invalidates the cached project reads", async () => {
    const t = make(full, [view, { body: { data: {} } }, view]);
    await t.run("github_project", { operation: "view", owner: "acme", number: 3 });
    await t.run("github_project", { operation: "view", owner: "acme", number: 3 });
    expect(t.calls).toHaveLength(1);
    await t.run("github_project", { operation: "set_field", owner: "acme", number: 3, item_id: "I", field: "Points", value: 1 });
    await t.run("github_project", { operation: "view", owner: "acme", number: 3 });
    expect(t.calls).toHaveLength(3);
  });
});

describe("cache invalidation of writes", () => {
  it("a label write drops the cached list of that repository", async () => {
    const t = make({ policy: presetPolicy("pr_workflow"), cacheTtlSeconds: 60 }, [{ body: [{ name: "a" }] }, { body: { name: "b" } }, { body: [{ name: "a" }, { name: "b" }] }]);
    await t.run("github_labels", { operation: "list" });
    await t.run("github_labels", { operation: "list" });
    expect(t.calls).toHaveLength(1);
    await t.run("github_labels", { operation: "create", name: "b" });
    await t.run("github_labels", { operation: "list" });
    expect(t.calls).toHaveLength(3);
  });
});
