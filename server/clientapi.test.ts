import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, presetPolicy, type AppEntry, type Config } from "../shared/config";
import { ActivityLog } from "./activity";
import type { FetchFn, TokenSource } from "./auth";
import { ResponseCache } from "./cache";
import { ClientApi, ClientApiServer, clientApiUrl, clientEnv, NO_TOKEN_PLACEHOLDER } from "./clientapi";
import { GitCredentials } from "./gitcred";
import { GithubProxy } from "./proxy";
import { RateLimitTracker } from "./ratelimit";
import { WebhookReceiver, WebhookServer } from "./webhook";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const acme: AppEntry = { id: "acme", organization: "acme", label: "", appId: "11", installationId: "77", owners: [], default: true };

type Reply = { status: number; headers?: Record<string, string>; body?: unknown };

function setup(opts: { preset?: "read_only" | "pr_workflow" | "full"; token?: string; replies?: Reply[]; owners?: string[]; denyRead?: string } = {}) {
  let now = 1_000_000;
  const config: Config = { ...defaultConfig(), policy: presetPolicy(opts.preset ?? "read_only", opts.denyRead ? [{ id: "r1", effect: "deny", repos: [opts.denyRead], actions: ["read"], reason: "secret repo" }] : []), allowedOwners: opts.owners ?? ["acme"] };
  const queue = [...(opts.replies ?? [])];
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fetchFn: FetchFn = vi.fn(async (url, init) => {
    calls.push({ url, ...init });
    const r = queue.shift() ?? { status: 200, body: {} };
    const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: r.status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => (r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  });
  const token = (): TokenSource => ({ id: "app", configured: () => true, token: async () => "tok-app", invalidate: () => undefined });
  const activity = new ActivityLog(100, () => now);
  const proxy = new GithubProxy({ config: () => config, gh: { ...token(), id: "gh" }, apps: { list: () => [acme], source: () => token() }, fetch: fetchFn, cache: new ResponseCache(null), tracker: new RateLimitTracker(() => now), activity, clock: () => now });
  const git = new GitCredentials({ proxy, apps: () => [acme], credentials: () => ({ appId: "11", installationId: "77", privateKey }), fetch: fetchFn, clock: () => now });
  const api = new ClientApi({ proxy, git, token: () => opts.token ?? "", clock: () => now });
  const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}, remoteAddress = "127.0.0.1") =>
    api.handle({ method, url, headers: { host: "127.0.0.1:8788", ...headers }, body: Buffer.from(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)), remoteAddress });
  return { api, call, calls, activity, git, advance: (ms: number) => (now += ms) };
}
const json = { "content-type": "application/json" };

describe("REST through the pipeline", () => {
  it("serves a read, forwards the query, ETag and Link, and caches it", async () => {
    const t = setup({ replies: [{ status: 200, headers: { ...json, etag: '"e1"', link: '<https://api.github.com/x?page=2>; rel="next"' }, body: [{ number: 1 }] }] });
    const r = await t.call("GET", "/v1/rest/repos/acme/web/pulls?state=open&per_page=5", undefined, { accept: "application/vnd.github+json" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual([{ number: 1 }]);
    expect(r.headers.etag).toBe('"e1"');
    expect(r.headers.link).toContain('rel="next"');
    expect(t.calls[0]!.url).toBe("https://api.github.com/repos/acme/web/pulls?state=open&per_page=5");
    expect(t.calls[0]!.headers.Authorization).toBe("Bearer tok-app");
    const again = await t.call("GET", "/v1/rest/repos/acme/web/pulls?state=open&per_page=5", undefined, { "if-none-match": '"e1"' });
    expect(again.status).toBe(304);
    expect(again.headers["x-proxy-cache"]).toBe("cache_hit");
    expect(t.calls).toHaveLength(1);
    expect(t.activity.list()[0]).toMatchObject({ agentId: "client", repo: "acme/web" });
  });

  it("denies a write under a read-only policy, naming the rule and action, without calling GitHub", async () => {
    const t = setup();
    const r = await t.call("POST", "/v1/rest/repos/acme/web/issues/3/comments", { body: "hi" });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toMatchObject({ error: "policy_denied", action: "comment", rule: "default policy" });
    expect(JSON.parse(r.body).message).toMatch(/default policy.*Do not retry/s);
    expect(t.calls).toHaveLength(0);
    expect(t.activity.list()[0]).toMatchObject({ status: "denied" });
  });

  it("sends an allowed write with its JSON body", async () => {
    const t = setup({ preset: "full", replies: [{ status: 201, headers: json, body: { id: 9 } }] });
    const r = await t.call("POST", "/v1/rest/repos/acme/web/issues/3/comments", { body: "hi" });
    expect(r.status).toBe(201);
    expect(t.calls[0]).toMatchObject({ method: "POST", url: "https://api.github.com/repos/acme/web/issues/3/comments", body: JSON.stringify({ body: "hi" }) });
  });

  it("refuses an owner outside the allowlist", async () => {
    const t = setup({ preset: "full" });
    const r = await t.call("GET", "/v1/rest/repos/evil/x");
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).message).toMatch(/not in the allowed owners/);
    expect(t.calls).toHaveLength(0);
  });

  it("passes GitHub's own error body and status through", async () => {
    const t = setup({ replies: [{ status: 404, headers: json, body: { message: "Not Found", documentation_url: "x" } }] });
    const r = await t.call("GET", "/v1/rest/repos/acme/missing");
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body)).toMatchObject({ message: "Not Found" });
  });

  it("rejects a non-JSON write body and unsupported methods", async () => {
    const t = setup({ preset: "full" });
    expect((await t.call("POST", "/v1/rest/repos/acme/web/issues", "not json")).status).toBe(400);
    expect((await t.call("TRACE", "/v1/rest/repos/acme/web")).status).toBe(405);
  });
});

describe("GraphQL through the pipeline", () => {
  it("runs a query with X-Proxy-Repo and denies a mutation under read-only", async () => {
    const t = setup({ replies: [{ status: 200, headers: json, body: { data: { repository: { id: "R" } } } }] });
    const ok = await t.call("POST", "/v1/graphql", { query: "query { repository(owner:\"acme\", name:\"web\") { id } }" }, { "x-proxy-repo": "acme/web" });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).data.repository.id).toBe("R");
    expect(t.calls[0]!.url).toBe("https://api.github.com/graphql");
    const denied = await t.call("POST", "/v1/graphql", { query: "mutation { mergePullRequest(input:{pullRequestId:\"x\"}) { clientMutationId } }" }, { "x-proxy-repo": "acme/web" });
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body)).toMatchObject({ error: "policy_denied", action: "generic_api_write" });
    expect(t.calls).toHaveLength(1);
  });

  it("needs a JSON body with a query", async () => {
    const t = setup();
    expect((await t.call("POST", "/v1/graphql", { variables: {} })).status).toBe(400);
    expect((await t.call("GET", "/v1/graphql")).status).toBe(405);
  });
});

describe("bearer token", () => {
  it("is required when set, and compared exactly", async () => {
    const t = setup({ token: "s3cret", replies: [{ status: 200, headers: json, body: {} }] });
    expect((await t.call("GET", "/v1/rest/repos/acme/web")).status).toBe(401);
    expect((await t.call("GET", "/v1/rest/repos/acme/web", undefined, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await t.call("GET", "/v1/rest/repos/acme/web", undefined, { authorization: "Bearer s3cret" })).status).toBe(200);
    expect(t.api.counters.unauthorized).toBe(2);
    // a token set means any peer may call, as long as it presents the token
    expect((await t.call("GET", "/v1/auth/status", undefined, { authorization: "Bearer s3cret" }, "10.0.0.5")).status).toBe(200);
  });

  it("is optional when unset, for this machine only and never for a browser", async () => {
    const t = setup({ replies: [{ status: 200, headers: json, body: {} }] });
    expect((await t.call("GET", "/v1/rest/repos/acme/web")).status).toBe(200);
    expect((await t.call("GET", "/v1/rest/repos/acme/web", undefined, {}, "10.0.0.5")).status).toBe(403);
    expect((await t.call("GET", "/v1/rest/repos/acme/web", undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await t.call("GET", "/v1/rest/repos/acme/web", undefined, { host: "rebind.evil.example:8788" })).status).toBe(403);
  });

  it("answers /healthz without one and shows the shim its principal", async () => {
    const t = setup({ token: "s3cret" });
    expect((await t.call("GET", "/healthz")).status).toBe(200);
    expect(JSON.parse((await t.call("GET", "/v1/auth/status", undefined, { authorization: "Bearer s3cret" })).body).name).toBeTruthy();
  });
});

describe("routes", () => {
  it("does not serve the webhook path or unknown routes, and says watch is unsupported", async () => {
    const t = setup();
    expect((await t.call("POST", "/webhook", "{}")).status).toBe(404);
    expect((await t.call("GET", "/v1/repos/acme/web/pulls/1/bundle")).status).toBe(404);
    expect((await t.call("GET", "/v1/watch/repos/acme/web/pulls/1")).status).toBe(501);
  });
});

describe("git credentials", () => {
  const tokenReply = (token = "ghs_tok", hours = 1): Reply => ({ status: 201, headers: json, body: { token, expires_at: new Date(1_000_000 + hours * 3_600_000).toISOString() } });

  it("answers only https://github.com/<owner>/<repo>", async () => {
    const t = setup({ replies: [tokenReply()] });
    for (const attrs of [
      { protocol: "http", host: "github.com", path: "acme/web.git" },
      { protocol: "https", host: "gitlab.com", path: "acme/web.git" },
      { protocol: "https", host: "github.com" },
      { protocol: "https", host: "github.com", path: "acme" },
      { protocol: "https", host: "github.com", path: "acme/web/extra" },
    ]) {
      const r = await t.call("POST", "/v1/git-credential", attrs);
      expect(r.status, JSON.stringify(attrs)).toBe(404);
      expect(JSON.parse(r.body).error).toBe("not_served");
    }
    expect(t.calls).toHaveLength(0);
    const ok = await t.call("POST", "/v1/git-credential", { protocol: "https", host: "GitHub.com", path: "acme/web.git" });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ username: "x-access-token", password: "ghs_tok", repository: "acme/web", access: "read" });
  });

  it("refuses an owner that is not allowed and a repo whose read is denied", async () => {
    const t = setup({ preset: "full", owners: ["other"] });
    const r = await t.call("POST", "/v1/git-credential", { protocol: "https", host: "github.com", path: "acme/web.git" });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).message).toMatch(/not in the allowed owners/);
    expect(t.calls).toHaveLength(0);

    const rule = setup({ preset: "full", denyRead: "acme/secret" });
    const d = await rule.call("POST", "/v1/git-credential", { protocol: "https", host: "github.com", path: "acme/secret.git" });
    expect(d.status).toBe(403);
    expect(JSON.parse(d.body)).toMatchObject({ error: "policy_denied", rule: "rule #1", action: "read" });
    expect(rule.calls).toHaveLength(0);
  });

  it("requests a read-only, one-repository token under a read-only policy", async () => {
    const t = setup({ replies: [tokenReply()] });
    const r = await t.call("POST", "/v1/git-credential", { protocol: "https", host: "github.com", path: "acme/web.git" });
    expect(JSON.parse(r.body).access).toBe("read");
    expect(t.calls[0]!.url).toBe("https://api.github.com/app/installations/77/access_tokens");
    expect(JSON.parse(t.calls[0]!.body!)).toEqual({ repositories: ["web"], permissions: { contents: "read", metadata: "read" } });
    expect(t.calls[0]!.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("requests a write token only where the policy allows write_file and create_branch", async () => {
    const full = setup({ preset: "full", replies: [tokenReply("ghs_w")] });
    const w = await full.call("POST", "/v1/git-credential", { protocol: "https", host: "github.com", path: "acme/web" });
    expect(JSON.parse(w.body).access).toBe("write");
    expect(JSON.parse(full.calls[0]!.body!).permissions).toEqual({ contents: "write", metadata: "read" });
    // PR workflow allows create_branch but not write_file: a read token
    const pr = setup({ preset: "pr_workflow", replies: [tokenReply()] });
    const r = await pr.call("POST", "/v1/git-credential", { protocol: "https", host: "github.com", path: "acme/web" });
    expect(JSON.parse(r.body).access).toBe("read");
  });

  it("the old /v1/git/token honors the access asked for, never more than the policy", async () => {
    const t = setup({ replies: [tokenReply()] });
    const denied = await t.call("POST", "/v1/git/token", { repository: "acme/web", access: "write" });
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body)).toMatchObject({ error: "policy_denied", action: "write_file" });
    expect(t.calls).toHaveLength(0);
    const read = await t.call("POST", "/v1/git/token", { repository: "acme/web" });
    expect(JSON.parse(read.body)).toMatchObject({ token: "ghs_tok", access: "read", repository: "acme/web" });
    const full = setup({ preset: "full", replies: [tokenReply()] });
    const asRead = await full.call("POST", "/v1/git/token", { repository: "acme/web", access: "read" });
    expect(JSON.parse(asRead.body).access).toBe("read");
    expect(JSON.parse(full.calls[0]!.body!).permissions.contents).toBe("read");
  });

  it("caches a token per repo and access until five minutes before it expires", async () => {
    const t = setup({ replies: [tokenReply("a"), tokenReply("b"), tokenReply("c")] });
    const ask = async (repo = "web") => JSON.parse((await t.call("POST", "/v1/git-credential", { protocol: "https", host: "github.com", path: `acme/${repo}.git` })).body).password;
    expect(await ask()).toBe("a");
    expect(await ask()).toBe("a");
    expect(await ask("api")).toBe("b"); // another repository, another token
    t.advance(54 * 60_000); // 6 minutes left: still reused
    expect(await ask()).toBe("a");
    t.advance(2 * 60_000); // 4 minutes left: renewed
    expect(await ask()).toBe("c");
    expect(t.calls).toHaveLength(3);
  });

  it("never logs or reports a token, and explains a refused permission", async () => {
    const t = setup({ replies: [{ status: 422, body: { message: "The permissions requested are not granted to this installation." } }] });
    const r = await t.call("POST", "/v1/git-credential", { protocol: "https", host: "github.com", path: "acme/web.git" });
    expect(r.status).toBe(502);
    expect(r.body).toMatch(/does not have the permission/);
    expect(JSON.stringify(t.activity.list())).not.toMatch(/ghs_|BEGIN/);
    expect(t.activity.list().some((e) => e.tool === "git credential" && e.action === "read")).toBe(true);
  });
});

describe("listeners", () => {
  const servers: { stop(): Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.stop()));
  });

  it("refuses a non-loopback bind without a token, and starts it with one", async () => {
    const t = setup();
    let tokenSet = false;
    const server = new ClientApiServer(t.api, () => tokenSet, () => ({ found: true, error: "" }));
    servers.push(server);
    await server.apply({ enabled: true, port: 0, bind: "0.0.0.0", injectEnv: true });
    expect(server.status()).toMatchObject({ listening: false, loopback: false });
    expect(server.status().error).toMatch(/without a token/);
    tokenSet = true;
    await server.apply({ enabled: true, port: 0, bind: "0.0.0.0", injectEnv: true });
    expect(server.status().listening).toBe(true);
  });

  it("is off by default, loopback by default, and serves REST over a real socket", async () => {
    const parsed = defaultConfig().clientApi;
    expect(parsed).toEqual({ enabled: false, port: 8788, bind: "127.0.0.1", injectEnv: true });
    const t = setup({ replies: [{ status: 200, headers: json, body: { ok: 1 } }] });
    const server = new ClientApiServer(t.api, () => false, () => ({ found: true, error: "" }));
    servers.push(server);
    await server.apply({ ...parsed, enabled: true, port: 0 });
    const port = server.address()!;
    const res = await fetch(`http://127.0.0.1:${port}/v1/rest/repos/acme/web`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: 1 });
    expect((await fetch(`http://127.0.0.1:${port}/webhook`, { method: "POST", body: "{}" })).status).toBe(404);
    await server.apply({ ...parsed, enabled: false });
    expect(server.status().listening).toBe(false);
  });

  it("the webhook listener does not serve /v1/*", async () => {
    const receiver = new WebhookReceiver({ secrets: () => [], apps: () => [], onEvent: () => undefined });
    const hooks = new WebhookServer(receiver, () => 0);
    servers.push(hooks);
    await hooks.apply({ enabled: true, port: 0, bind: "127.0.0.1" });
    const port = hooks.address()!;
    for (const path of ["/v1/rest/repos/acme/web", "/v1/graphql", "/v1/git-credential", "/v1/auth/status"]) {
      expect((await fetch(`http://127.0.0.1:${port}${path}`, { method: path === "/v1/rest/repos/acme/web" ? "GET" : "POST", body: path === "/v1/rest/repos/acme/web" ? undefined : "{}" })).status, path).toBe(404);
    }
  });
});

describe("environment injection", () => {
  const config = { enabled: true, port: 8788, bind: "127.0.0.1", injectEnv: true };
  it("sets the proxy URL, the token and the git configuration", () => {
    const env = clientEnv({ config, token: "tok", helperPath: "/data/git-credential-helper.mjs", nodePath: "/usr/lib/node/bin/node" });
    expect(env).toEqual({
      GH_PROXY_URL: "http://127.0.0.1:8788",
      GH_PROXY_TOKEN: "tok",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_1: "!'/usr/lib/node/bin/node' '/data/git-credential-helper.mjs'",
      GIT_CONFIG_KEY_2: "credential.https://github.com.useHttpPath",
      GIT_CONFIG_VALUE_2: "true",
    });
  });
  it("uses a placeholder token the shim accepts, appends to existing git config and quotes the path", () => {
    const env = clientEnv({ config, token: "", helperPath: "/home/o'neil/x y.mjs", existing: { GIT_CONFIG_COUNT: "2" } });
    expect(env.GH_PROXY_TOKEN).toBe(NO_TOKEN_PLACEHOLDER);
    expect(env.GIT_CONFIG_COUNT).toBe("5");
    expect(env.GIT_CONFIG_KEY_2).toBe("credential.https://github.com.helper");
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_3).toBe(`!'node' '/home/o'\\''neil/x y.mjs'`);
  });
  it("skips git when the helper script is missing, and maps a wildcard bind to loopback", () => {
    const env = clientEnv({ config: { ...config, bind: "0.0.0.0" }, token: "", helperPath: null });
    expect(Object.keys(env).sort()).toEqual(["GH_PROXY_TOKEN", "GH_PROXY_URL"]);
    expect(env.GH_PROXY_URL).toBe("http://127.0.0.1:8788");
    expect(clientApiUrl({ bind: "::1", port: 9 })).toBe("http://[::1]:9");
  });
});
