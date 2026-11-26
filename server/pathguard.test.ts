import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig, presetPolicy, type AppEntry, type Config } from "../shared/config";
import { ActivityLog } from "./activity";
import type { FetchFn, TokenSource } from "./auth";
import { ResponseCache } from "./cache";
import { ClientApi } from "./clientapi";
import { GitCredentials } from "./gitcred";
import { canonicalRestPath, parseOwner, parseRepo } from "./path";
import { GithubProxy } from "./proxy";
import { RateLimitTracker } from "./ratelimit";
import { buildTools } from "./tools";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const app: AppEntry = { id: "a", organization: "allowed", label: "", appId: "11", installationId: "77", owners: [], default: true };

/** Everything wired to one fake fetch: the tests assert what reaches it (never anything for a refused call). */
function setup(owners = ["allowed"]) {
  const config: Config = { ...defaultConfig(), policy: presetPolicy("full"), allowedOwners: owners };
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetchFn: FetchFn = vi.fn(async (url, init) => {
    calls.push({ url, method: init.method, ...(init.body ? { body: init.body } : {}) });
    const body = url.endsWith("/access_tokens") ? { token: "t", expires_at: "2099-01-01T00:00:00Z" } : [];
    return { status: url.endsWith("/access_tokens") ? 201 : 200, headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null) }, text: async () => JSON.stringify(body) };
  });
  const source: TokenSource = { id: "app", configured: () => true, token: async () => "tok", invalidate() {} };
  const proxy = new GithubProxy({ config: () => config, gh: { ...source, id: "gh" }, apps: { list: () => [app], source: () => source }, fetch: fetchFn, cache: new ResponseCache(null), tracker: new RateLimitTracker(), activity: new ActivityLog() });
  const git = new GitCredentials({ proxy, apps: () => [app], credentials: () => ({ appId: "11", installationId: "77", privateKey }), fetch: fetchFn });
  const api = new ClientApi({ proxy, git, token: () => "" });
  const tools = buildTools({ proxy, softRule: false, remoteOf: async () => "git@github.com:allowed/web.git" });
  const tool = async (name: string, input: unknown) => {
    const t = tools.find((x) => x.name === name)!;
    return t.execute(t.input.parse(input), { agent: { id: "a1", title: "A", cwd: "/w", workspaceId: null, parentAgentId: null, provider: "x", background: false, metadata: {} }, paseo: {} as never, signal: new AbortController().signal });
  };
  const client = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    api.handle({ method, url, headers: { host: "127.0.0.1:8788", ...headers }, body: Buffer.from(body === undefined ? "" : JSON.stringify(body)), remoteAddress: "127.0.0.1" });
  return { proxy, calls, tool, client, activity: proxy["deps"].activity as ActivityLog };
}

const BAD_PATHS: [string, string][] = [
  ["dot segments", "/repos/allowed/x/../../victim/secret/contents/f"],
  ["single dot segment", "/repos/allowed/x/./contents/f"],
  ["encoded dots", "/repos/allowed/x/%2e%2e/%2e%2e/victim/secret"],
  ["upper-case encoded dot", "/repos/allowed/x/%2E%2E/%2E%2E/victim/secret"],
  ["mixed encoded dot", "/repos/allowed/x/.%2e/.%2E/victim/secret"],
  ["encoded slash", "/repos/allowed/x%2f..%2f..%2fvictim/secret"],
  ["encoded slash later", "/repos/allowed/x/contents/a%2Fb"],
  ["encoded backslash", "/repos/allowed/x/contents/..%5c..%5cvictim"],
  ["double encoded dot", "/repos/allowed/x/%252e%252e/y"],
  ["double slash", "/repos/allowed//x/contents"],
  ["leading double slash", "//repos/allowed/x"],
  ["trailing slash", "/repos/allowed/x/"],
  ["backslash", "/repos/allowed/x\\..\\..\\victim/secret"],
  ["query in path", "/repos/allowed/x/contents/f?ref=../../../victim"],
  ["fragment in path", "/repos/allowed/x/contents/f#/../../victim/secret"],
  ["encoded query char left raw", "/repos/allowed/x/contents/f?"],
  ["tab", "/repos/allowed/x/contents/a\tb"],
  ["newline", "/repos/allowed/x/contents/a\nb"],
  ["NUL", "/repos/allowed/x/contents/a\u0000b"],
  ["encoded NUL", "/repos/allowed/x/contents/a%00b"],
  ["space", "/repos/allowed/x/contents/a b"],
  ["absolute URL", "https://api.github.com/repos/allowed/x"],
  ["other host URL", "https://evil.example/repos/allowed/x"],
  ["scheme-relative", "//evil.example/repos/allowed/x"],
  ["no leading slash", "repos/allowed/x"],
  ["non-ASCII owner", "/repos/allowеd/x/contents"],
  ["non-ASCII repo", "/repos/allowed/xé/contents"],
  ["encoded owner", "/repos/%61llowed/x"],
  ["encoded repo", "/repos/allowed/%78"],
  ["dot repo", "/repos/allowed/.."],
  ["bad escape", "/repos/allowed/x/contents/%zz"],
  ["bad utf8 escape", "/repos/allowed/x/contents/%ff"],
  ["org with slash tricks", "/orgs/allowed%2fx/repos"],
  ["user dot", "/users/../orgs/victim/repos"],
];

describe("canonicalRestPath", () => {
  it.each(BAD_PATHS)("refuses %s", (_name, path) => {
    expect(() => canonicalRestPath(path)).toThrow(/Do not retry/);
  });
  it("accepts ordinary paths unchanged", () => {
    for (const p of ["/user", "/rate_limit", "/orgs/o/repos", "/users/o/repos", "/repos/o/r", "/repos/o/r/contents/dir/file.txt", "/repos/o/r/contents/my%20file.md", "/repos/o/r/git/refs/heads/feature/x", "/repos/o/.github/pulls", "/repos/o/my.repo_1-x/pulls/3", "/search/issues"]) expect(canonicalRestPath(p)).toBe(p);
  });
  it("validates names", () => {
    expect(parseRepo("Acme/web.js").owner).toBe("Acme");
    for (const r of ["a", "a/b/c", "a/..", "a/.", "-a/b", "a b/c", "a/b%2f", "a/é", "../b", "a/", "/b"]) expect(() => parseRepo(r), r).toThrow();
    for (const o of ["", "-x", "a/b", "a b", "é", "x".repeat(40)]) expect(() => parseOwner(o), o).toThrow();
  });
});

describe("github_api tool", () => {
  it.each(BAD_PATHS)("refuses %s and sends nothing", async (_name, path) => {
    const t = setup(["*"]);
    const r = await t.tool("github_api", { kind: "rest", path });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Do not retry/);
    expect(t.calls).toHaveLength(0);
    expect(t.activity.list()[0]).toMatchObject({ status: "denied" });
  });
  it("an allowed-owner policy cannot be bypassed with dot segments", async () => {
    const t = setup();
    const r = await t.tool("github_api", { kind: "rest", path: "/repos/allowed/x/../../other/y" });
    expect(r.isError).toBe(true);
    expect(t.calls).toHaveLength(0);
  });
  it("keeps working for normal calls, with the query only in params", async () => {
    const t = setup(["*"]);
    await t.tool("github_api", { kind: "rest", path: "/repos/allowed/web/contents/dir/file.txt", params: { ref: "feature/x y" } });
    await t.tool("github_api", { kind: "rest", path: "/search/issues", params: { q: "bug repo:allowed/web" } });
    await t.tool("github_api", { kind: "rest", path: "/user" });
    await t.tool("github_api", { kind: "rest", path: "/orgs/allowed/repos" });
    await t.tool("github_api", { kind: "rest", path: "/rate_limit" });
    expect(t.calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/allowed/web/contents/dir/file.txt?ref=feature%2Fx+y",
      "https://api.github.com/search/issues?q=bug+repo%3Aallowed%2Fweb",
      "https://api.github.com/user",
      "https://api.github.com/orgs/allowed/repos",
      "https://api.github.com/rate_limit",
    ]);
  });
  it("sends a graphql call with a plain repo, refuses a malformed one", async () => {
    const t = setup();
    expect((await t.tool("github_api", { kind: "graphql", query: "{ viewer { login } }", repo: "allowed/web" })).isError).toBeUndefined();
    for (const repo of ["allowed/web/../../victim/y", "allowed/web?x", "allowed", "allowed/%2e%2e"]) {
      const r = await t.tool("github_api", { kind: "graphql", query: "{ viewer { login } }", repo });
      expect(r.isError, repo).toBe(true);
    }
    expect(t.calls).toHaveLength(1);
  });
});

describe("curated tools", () => {
  const BAD_REPOS = ["allowed/x/../../victim/y", "allowed/x%2f..", "allowed/x?y", "allowed/x#y", "allowed/x y", "allowed/..", "allowed/x/y", "allowed\\x", "allówed/x"];
  it.each(BAD_REPOS)("github_get_pr refuses repo %j", async (repo) => {
    const t = setup(["*"]);
    expect((await t.tool("github_get_pr", { repo, number: 1 })).isError).toBe(true);
    expect((await t.tool("github_list_prs", { repo })).isError).toBe(true);
    expect((await t.tool("github_contents", { repo, operation: "read", path: "a" })).isError).toBe(true);
    expect((await t.tool("github_subscribe", { repo, events: ["pr_merged"], pr: 1 }).catch(() => ({ isError: true }))).isError).toBe(true);
    expect(t.calls).toHaveLength(0);
  });
  it("refuses a bad owner argument of the account and search tools", async () => {
    const t = setup(["*"]);
    for (const owner of ["allowed/repos/x/y", "..", "a%2fb", "a b", "a?b"]) {
      expect((await t.tool("github_account", { operation: "org_members", owner })).isError, owner).toBe(true);
      expect((await t.tool("github_account", { operation: "list_repos", owner })).isError, owner).toBe(true);
      expect((await t.tool("github_gists", { operation: "list", user: owner })).isError, owner).toBe(true);
      expect((await t.tool("github_project", { operation: "list", owner })).isError, owner).toBe(true);
      expect((await t.tool("github_search", { query: "x", org: owner })).isError, owner).toBe(true);
    }
    expect((await t.tool("github_search", { query: "x", repo: "allowed/x repo:victim/y" })).isError).toBe(true);
    expect(t.calls).toHaveLength(0);
  });
  it("a file path with dot segments cannot leave the repository", async () => {
    const t = setup();
    const r = await t.tool("github_contents", { repo: "allowed/web", operation: "read", path: "../../../victim/secret/contents/f" });
    expect(r.isError).toBe(true);
    expect(t.calls).toHaveLength(0);
  });
  it("still reads the root, a directory and a file, and encodes names", async () => {
    const t = setup();
    await t.tool("github_contents", { repo: "allowed/web", operation: "read" });
    await t.tool("github_contents", { repo: "allowed/web", operation: "read", path: "/dir/my file.md" });
    expect(t.calls.map((c) => c.url)).toEqual(["https://api.github.com/repos/allowed/web/contents", "https://api.github.com/repos/allowed/web/contents/dir/my%20file.md"]);
  });
});

describe("client API", () => {
  // Over HTTP a `?` starts the query and the leading slash is the route, so those cases are not paths here.
  const encodedForUrl = BAD_PATHS.filter(([, p]) => !p.includes("?") && p.startsWith("/"));
  it.each(encodedForUrl)("/v1/rest refuses %s", async (_name, path) => {
    const t = setup(["*"]);
    const r = await t.client("GET", `/v1/rest${path.startsWith("/") ? path : `/${path}`}`);
    expect([400, 403, 404]).toContain(r.status);
    expect(t.calls).toHaveLength(0);
  });
  it("/v1/rest refuses an allowed-owner bypass", async () => {
    const t = setup();
    const r = await t.client("GET", "/v1/rest/repos/allowed/x/../../other/y");
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).message).toMatch(/Do not retry/);
    expect(t.calls).toHaveLength(0);
  });
  it("/v1/rest keeps the query as a query and works for normal paths", async () => {
    const t = setup();
    expect((await t.client("GET", "/v1/rest/repos/allowed/web/contents/dir/file.txt?ref=feature%2Fx")).status).toBe(200);
    expect((await t.client("GET", "/v1/rest/repos/allowed/web/pulls?head=allowed:feature/x&state=open")).status).toBe(200);
    expect(t.calls[0]!.url).toBe("https://api.github.com/repos/allowed/web/contents/dir/file.txt?ref=feature%2Fx");
    expect(new URL(t.calls[1]!.url).pathname).toBe("/repos/allowed/web/pulls");
    // a query that tries to look like a path stays in the query
    expect((await t.client("GET", "/v1/rest/repos/allowed/web/pulls?x=/../../../victim/y")).status).toBe(200);
    expect(new URL(t.calls[2]!.url).pathname).toBe("/repos/allowed/web/pulls");
  });
  it("/v1/graphql validates X-Proxy-Repo", async () => {
    const t = setup();
    const body = { query: "{ viewer { login } }" };
    for (const repo of ["allowed/web/../../victim/y", "allowed/%2e%2e", "allowed/web?x=1", "allowed", "allowed/web y", "a/b/c"]) {
      const r = await t.client("POST", "/v1/graphql", body, { "x-proxy-repo": repo });
      expect(r.status, repo).toBe(403);
    }
    expect(t.calls).toHaveLength(0);
    expect((await t.client("POST", "/v1/graphql", body, { "x-proxy-repo": "allowed/web" })).status).toBe(200);
  });
  it("/v1/git-credential and /v1/git/token only mint for a plain owner/name", async () => {
    const t = setup();
    for (const path of ["allowed/x/../victim/y", "allowed/%2e%2e", "allowed/x?y", "allowed/x y", "allowed/x/y", "../victim", "allowed/..", "allowed/é"]) {
      const a = await t.client("POST", "/v1/git-credential", { protocol: "https", host: "github.com", path });
      expect(a.status, path).toBeGreaterThanOrEqual(400);
      const b = await t.client("POST", "/v1/git/token", { repository: path });
      expect(b.status, path).toBeGreaterThanOrEqual(400);
    }
    expect(t.calls).toHaveLength(0);
    const ok = await t.client("POST", "/v1/git-credential", { protocol: "https", host: "github.com", path: "allowed/web.git" });
    expect(ok.status).toBe(200);
    expect(JSON.parse(t.calls.find((c) => c.url.endsWith("/access_tokens"))!.body!).repositories).toEqual(["web"]);
  });
});

describe("proxy", () => {
  it("builds the URL once and uses it for the cache: two spellings never share an entry", async () => {
    const t = setup();
    await t.proxy.rest({ agentId: "a", agentTitle: "A", tool: "t" }, { method: "GET", path: "/repos/allowed/web/pulls" });
    await expect(t.proxy.rest({ agentId: "a", agentTitle: "A", tool: "t" }, { method: "GET", path: "/repos/allowed/web/./pulls" })).rejects.toThrow(/Do not retry/);
    expect(t.calls).toHaveLength(1);
  });
  it("refuses a base URL the path could escape", async () => {
    const t = setup(["*"]);
    for (const path of ["/@evil.example/x", "/:80/x"]) {
      // These are plain printable paths: they must stay on the API host.
      await t.proxy.rest({ agentId: "a", agentTitle: "A", tool: "t" }, { method: "GET", path }).catch(() => undefined);
    }
    for (const c of t.calls) expect(new URL(c.url).origin).toBe("https://api.github.com");
  });
});
