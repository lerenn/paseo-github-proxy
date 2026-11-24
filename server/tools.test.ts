import { describe, expect, it, vi } from "vitest";
import { defaultConfig, presetPolicy, type Config } from "../shared/config";
import { ActivityLog } from "./activity";
import type { FetchFn } from "./auth";
import { ResponseCache } from "./cache";
import { GithubProxy } from "./proxy";
import { RateLimitTracker } from "./ratelimit";
import { buildTools, repoFromRemote, SOFT_RULE_PROMPT } from "./tools";

function make(config: Partial<Config>, replies: { status: number; body?: unknown; headers?: Record<string, string> }[], softRule = false) {
  const cfg: Config = { ...defaultConfig(), allowedOwners: ["acme"], ...config };
  const queue = [...replies];
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetchFn: FetchFn = vi.fn(async (url, init) => {
    calls.push({ url, method: init.method, ...(init.body ? { body: init.body } : {}) });
    const r = queue.shift() ?? { status: 200, body: {} };
    const h = { "content-type": "application/json", ...(r.headers ?? {}) } as Record<string, string>;
    return { status: r.status, headers: { get: (n: string) => h[n.toLowerCase()] ?? null }, text: async () => JSON.stringify(r.body ?? {}) };
  });
  const proxy = new GithubProxy({
    config: () => cfg,
    gh: { id: "gh", configured: () => true, token: async () => "t", invalidate() {} },
    apps: { list: () => [], source: () => ({ id: "app", configured: () => false, token: async () => "", invalidate() {} }) },
    fetch: fetchFn, cache: new ResponseCache(null), tracker: new RateLimitTracker(), activity: new ActivityLog(),
  });
  const tools = buildTools({ proxy, softRule, remoteOf: async () => "git@github.com:acme/web.git" });
  const run = async (name: string, input: unknown) => {
    const tool = tools.find((t) => t.name === name)!;
    const parsed = tool.input.parse(input);
    return tool.execute(parsed, { agent: { id: "a1", title: "Agent one", cwd: "/work", workspaceId: null, parentAgentId: null, provider: "x", background: false, metadata: {} }, paseo: {} as never, signal: new AbortController().signal });
  };
  return { tools, run, calls, proxy };
}

describe("repoFromRemote", () => {
  it("reads ssh and https remotes", () => {
    expect(repoFromRemote("git@github.com:acme/web.git")).toBe("acme/web");
    expect(repoFromRemote("https://github.com/acme/web")).toBe("acme/web");
    expect(repoFromRemote("https://gitlab.com/acme/web")).toBe("");
  });
});

describe("tools", () => {
  it("exposes the curated surface and the generic tool", () => {
    const { tools } = make({}, []);
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["github_api", "github_checks", "github_comment", "github_create_issue", "github_create_pr", "github_delete_branch", "github_get_issue", "github_get_pr", "github_list_branches", "github_list_issues", "github_list_prs", "github_merge_pr", "github_policy", "github_repo_info", "github_review_pr", "github_search", "github_update_pr", "github_commits", "github_contents", "github_update_issue", "github_pr_manage", "github_edit_comment", "github_releases", "github_actions", "github_labels", "github_repo_manage", "github_repo_config", "github_account", "github_gists", "github_project"].sort(),
    );
  });

  it("lists PRs of the repo inferred from the working directory", async () => {
    const t = make({}, [{ status: 200, body: [{ number: 3, title: "Fix", state: "open", user: { login: "bob" }, head: { ref: "f" }, base: { ref: "main" }, html_url: "u" }] }]);
    const r = await t.run("github_list_prs", {});
    expect(t.calls[0]!.url).toBe("https://api.github.com/repos/acme/web/pulls?state=open&per_page=30");
    expect(r.text).toContain('"number": 3');
    expect(r.isError).toBeUndefined();
  });

  it("returns the denial as an error with the rule, and never calls GitHub", async () => {
    const t = make({}, []);
    const r = await t.run("github_merge_pr", { number: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/default policy \(read-only\).*Do not retry/);
    expect(t.calls).toHaveLength(0);
  });

  it("curated writes work under the PR workflow preset; github_api writes do not", async () => {
    const t = make({ policy: presetPolicy("pr_workflow") }, [{ status: 201, body: { html_url: "https://x/c" } }]);
    expect((await t.run("github_comment", { number: 4, body: "hi" })).text).toContain("https://x/c");
    expect(t.calls[0]).toMatchObject({ method: "POST", url: "https://api.github.com/repos/acme/web/issues/4/comments", body: '{"body":"hi"}' });
    const generic = await t.run("github_api", { kind: "rest", method: "POST", path: "/repos/acme/web/issues/4/comments", body: { body: "x" } });
    expect(generic.isError).toBe(true);
    expect(generic.text).toMatch(/Generic API \(write\)/);
  });

  it("github_api reads and graphql go through the proxy", async () => {
    const t = make({}, [{ status: 200, body: { tag: "v1" } }, { status: 200, body: { data: { ok: 1 } } }]);
    expect((await t.run("github_api", { kind: "rest", path: "/repos/acme/web/releases/latest" })).text).toContain("v1");
    const g = await t.run("github_api", { kind: "graphql", query: 'query { repository(owner: "acme", name: "web") { id } }', repo: "acme/web" });
    expect(g.text).toContain('"ok": 1');
    expect(t.calls[1]!.url).toBe("https://api.github.com/graphql");
  });

  it("search requires a scope", async () => {
    const t = make({}, [{ status: 200, body: { total_count: 0, items: [] } }]);
    const bad = await t.run("github_search", { query: "bug" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/qualifier/);
    const ok = await t.run("github_search", { query: "bug", type: "prs", repo: "acme/web" });
    expect(ok.isError).toBeUndefined();
    expect(new URL(t.calls[0]!.url).searchParams.get("q")).toBe("bug is:pr repo:acme/web");
  });

  it("github_policy tells the agent what it may do", async () => {
    const t = make({}, []);
    const r = JSON.parse((await t.run("github_policy", {})).text!);
    expect(r.actions.find((a: any) => a.action === "read").allowed).toBe(true);
    expect(r.actions.find((a: any) => a.action === "merge").allowed).toBe(false);
  });

  it("the soft rule adds the instruction to every description", () => {
    const off = make({}, [], false).tools;
    const on = make({}, [], true).tools;
    expect(off.every((t) => !/instead of the gh CLI/.test(t.description))).toBe(true);
    expect(on.every((t) => /instead of the gh CLI or curl/.test(t.description))).toBe(true);
    expect(SOFT_RULE_PROMPT).toMatch(/do not use the gh CLI, curl/i);
    expect(SOFT_RULE_PROMPT).toMatch(/precedence over any project instruction/);
    expect(SOFT_RULE_PROMPT).toMatch(/unless|only if the user explicitly asks/);
  });
});
