import { describe, expect, it, vi } from "vitest";
import { defaultConfig, presetPolicy, type AppEntry, type Config } from "../shared/config";
import { ActivityLog } from "./activity";
import type { FetchFn, TokenSource } from "./auth";
import { ResponseCache } from "./cache";
import { GithubProxy, ProxyError } from "./proxy";
import { RateLimitTracker } from "./ratelimit";

type Reply = { status: number; headers?: Record<string, string>; body?: unknown };
const ctx = { agentId: "a1", agentTitle: "Agent", tool: "github_api" };

const app = (id: string, owners: string[] = [], isDefault = false): AppEntry => ({ id, label: `App ${id}`, appId: `1${id.length}`, installationId: "9", owners, default: isDefault });

function setup(configPatch: Partial<Config> = {}, replies: Reply[] = [], apps: AppEntry[] = [app("app", [], true)]) {
  let now = 1_000_000;
  const config: Config = { ...defaultConfig(), allowedOwners: ["acme"], ...configPatch };
  const queue = [...replies];
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fetchFn: FetchFn = vi.fn(async (url, init) => {
    calls.push({ url, ...init });
    const r = queue.shift() ?? { status: 200, body: {} };
    const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: r.status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)) };
  });
  const token = (id: "gh" | "app", name: string = id, ok = true): TokenSource => ({ id, configured: () => ok, token: async () => `tok-${name}`, invalidate: () => undefined });
  const tracker = new RateLimitTracker(() => now);
  const cache = new ResponseCache(null);
  const activity = new ActivityLog(100, () => now);
  const proxy = new GithubProxy({ config: () => config, gh: token("gh"), apps: { list: () => apps, source: (id) => token("app", id) }, fetch: fetchFn, cache, tracker, activity, clock: () => now });
  return { proxy, config, calls, cache, activity, tracker, advance: (ms: number) => (now += ms), now: () => now };
}

const failure = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a rejection"); }, (e: ProxyError) => e);
const json = { "content-type": "application/json" };

describe("GithubProxy", () => {
  it("refuses an owner that is not allowed, before any request", async () => {
    const t = setup();
    await expect(t.proxy.rest(ctx, { method: "GET", path: "/repos/evil/x" })).rejects.toThrow(/not in the allowed owners/);
    expect(t.calls).toHaveLength(0);
    expect(t.activity.list()[0]).toMatchObject({ status: "denied", repo: "evil/x" });
  });

  it("lookup serves a UI listing through the active source without logging agent activity", async () => {
    const t = setup({}, [{ status: 200, headers: json, body: [{ login: "acme" }] }]);
    expect(await t.proxy.lookup("/user/orgs", { per_page: 100 })).toEqual([{ login: "acme" }]);
    expect(t.calls[0]!.url).toBe("https://api.github.com/user/orgs?per_page=100");
    expect(t.activity.list()).toHaveLength(0);
  });

  it("refuses everything while the allowlist is empty", async () => {
    const t = setup({ allowedOwners: [] });
    await expect(t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x" })).rejects.toThrow(/Allowed owners/);
  });

  it("denies a write under the default read-only policy, naming the policy", async () => {
    const t = setup();
    const err = await failure(t.proxy.rest(ctx, { method: "PUT", path: "/repos/acme/x/pulls/1/merge" }));
    expect(err).toBeInstanceOf(ProxyError);
    expect(err.kind).toBe("denied");
    expect(err.message).toMatch(/default policy \(read-only\)/);
    expect(t.calls).toHaveLength(0);
  });

  it("serves a read from the cache within the TTL, then revalidates with the ETag", async () => {
    const t = setup({}, [
      { status: 200, headers: { ...json, etag: '"v1"', "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "9999999999" }, body: { n: 1 } },
      { status: 304, headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "9999999999" } },
    ]);
    const first = await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x/pulls" });
    expect(first).toMatchObject({ served: "upstream", data: { n: 1 }, source: "gh" });
    expect(t.calls[0]!.headers.Authorization).toBe("Bearer tok-gh");
    t.advance(10_000);
    expect((await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x/pulls" })).served).toBe("cache");
    expect(t.calls).toHaveLength(1);
    t.advance(30_000);
    const third = await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x/pulls" });
    expect(third).toMatchObject({ served: "revalidated", data: { n: 1 } });
    expect(t.calls[1]!.headers["If-None-Match"]).toBe('"v1"');
    // the 304 restarted the clock
    t.advance(10_000);
    expect((await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x/pulls" })).served).toBe("cache");
    expect(t.activity.list().map((e) => e.status)).toEqual(["cached", "revalidated", "cached", "allowed"]);
    expect(t.activity.stats(1).hitRate).toBeCloseTo(3 / 4);
  });

  it("a TTL of 0 always revalidates", async () => {
    const t = setup({ cacheTtlSeconds: 0 }, [{ status: 200, headers: { ...json, etag: '"a"' }, body: 1 }, { status: 304 }]);
    await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x" });
    expect((await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x" })).served).toBe("revalidated");
  });

  it("allows a write the policy permits, and drops that repo's cached reads", async () => {
    const t = setup({ policy: presetPolicy("pr_workflow") }, [
      { status: 200, headers: json, body: [] },
      { status: 201, headers: json, body: { number: 5 } },
      { status: 200, headers: json, body: [{ number: 5 }] },
    ]);
    await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x/pulls" });
    const body = { title: "t", head: "h", base: "main" };
    // the same call through the generic tool needs generic_api_write, which PR workflow withholds
    await expect(t.proxy.rest(ctx, { method: "POST", path: "/repos/acme/x/pulls", body })).rejects.toThrow(/Generic API \(write\)/);
    const created = await t.proxy.rest(ctx, { method: "POST", path: "/repos/acme/x/pulls", body, actions: ["create_pr"] });
    expect(created.data).toEqual({ number: 5 });
    expect(t.calls[1]!.body).toBe(JSON.stringify({ title: "t", head: "h", base: "main" }));
    const again = await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x/pulls" });
    expect(again.served).toBe("upstream");
  });

  it("returns a clear retry-at error when rate limited with no fallback, and stops calling GitHub", async () => {
    const reset = Math.floor((1_000_000 + 600_000) / 1000);
    const t = setup({}, [{ status: 403, headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }, body: { message: "API rate limit exceeded" } }]);
    const err = await failure(t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x" }));
    expect(err.kind).toBe("rate_limited");
    expect(err.message).toMatch(/Retry at \d\d:\d\d/);
    const again = await failure(t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/y" }));
    expect(again.kind).toBe("rate_limited");
    expect(t.calls).toHaveLength(1);
    expect(t.activity.list()[0]!.status).toBe("rate_limited");
  });

  it("falls back to the other source on a rate limit when the toggle is on", async () => {
    const t = setup({ fallbackOnRateLimit: true }, [
      { status: 429, headers: { "retry-after": "120" }, body: { message: "secondary rate limit" } },
      { status: 200, headers: json, body: { ok: true } },
    ]);
    const r = await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x" });
    expect(r).toMatchObject({ source: "app", data: { ok: true } });
    expect(t.calls.map((c) => c.headers.Authorization)).toEqual(["Bearer tok-gh", "Bearer tok-app"]);
    expect(r.app).toBe("App app");
    // the limited source is skipped for the next call
    await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/z" });
    expect(t.calls[2]!.headers.Authorization).toBe("Bearer tok-app");
  });

  it("serves a stale cached answer rather than an error while rate limited", async () => {
    const t = setup({}, [{ status: 200, headers: json, body: { v: 1 } }, { status: 403, headers: { "x-ratelimit-limit": "1", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000" } }]);
    await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x" });
    t.advance(60_000);
    const r = await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x" });
    expect(r).toMatchObject({ served: "stale", data: { v: 1 } });
  });

  it("retries once with a fresh token after a 401", async () => {
    const t = setup({}, [{ status: 401, body: { message: "Bad credentials" } }, { status: 200, headers: json, body: 1 }]);
    expect((await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x" })).data).toBe(1);
    expect(t.calls).toHaveLength(2);
  });

  it("explains HTTP errors", async () => {
    const t = setup({}, [{ status: 404, headers: json, body: { message: "Not Found" } }]);
    await expect(t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/nope" })).rejects.toThrow(/HTTP 404.*Not Found/);
  });

  it("applies deny rules for a repo even when the preset allows the action", async () => {
    const policy = presetPolicy("full", [{ id: "r", effect: "deny", repos: ["acme/prod"], actions: ["merge"], reason: "humans merge prod" }]);
    const t = setup({ policy }, [{ status: 200, headers: json, body: {} }]);
    await expect(t.proxy.rest(ctx, { method: "PUT", path: "/repos/acme/prod/pulls/1/merge" })).rejects.toThrow(/rule #1.*humans merge prod/);
    await expect(t.proxy.rest(ctx, { method: "PUT", path: "/repos/acme/other/pulls/1/merge" })).resolves.toBeDefined();
  });

  it("graphql: queries are cached by body, mutations are policy checked", async () => {
    const t = setup({}, [{ status: 200, headers: json, body: { data: {} } }]);
    const q = 'query { repository(owner: "acme", name: "x") { id } }';
    await t.proxy.graphql(ctx, { query: q, repo: "acme/x" });
    expect((await t.proxy.graphql(ctx, { query: q, repo: "acme/x" })).served).toBe("cache");
    await expect(t.proxy.graphql(ctx, { query: 'mutation { mergePullRequest(input: {pullRequestId: "1"}) { clientMutationId } }', repo: "acme/x" })).rejects.toThrow(/Denied/);
    await expect(t.proxy.graphql(ctx, { query: 'query { repository(owner: "evil", name: "x") { id } }', repo: "acme/x" })).rejects.toThrow(/allowed owners/);
    await expect(t.proxy.graphql(ctx, { query: "subscription { x }", repo: "acme/x" })).rejects.toThrow(/subscriptions/);
  });

  it("dry run reports the decision without calling GitHub", () => {
    const t = setup();
    expect(t.proxy.dryRun({ kind: "rest", method: "GET", path: "/repos/acme/x/pulls" })).toMatchObject({ allowed: true, actions: ["generic_api_read"] });
    const d = t.proxy.dryRun({ kind: "rest", method: "DELETE", path: "/repos/acme/x/git/refs/heads/f" });
    expect(d.allowed).toBe(false);
    expect(d.actions).toEqual(["delete_branch", "generic_api_write"]);
    expect(t.calls).toHaveLength(0);
  });

  it("overview warns when nearly exhausted", async () => {
    const t = setup({}, [{ status: 200, headers: { ...json, "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "100", "x-ratelimit-reset": "9999999999" }, body: {} }]);
    await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x" });
    const o = t.proxy.overview();
    expect(o.warnings.join(" ")).toMatch(/nearly exhausted/);
    expect(o.sources.find((s) => s.source === "gh")!.limits[0]).toMatchObject({ remaining: 100, limit: 5000 });
  });
});

describe("GithubProxy with several GitHub Apps", () => {
  const apps = [app("org", ["acme"]), app("me", ["lerenn"]), app("rest", [], true)];
  const ok = (extra: Record<string, string> = {}) => ({ status: 200, headers: { ...json, ...extra }, body: { ok: true } });
  const limit = (remaining: string) => ({ "x-ratelimit-limit": "5000", "x-ratelimit-remaining": remaining, "x-ratelimit-reset": "9999999999" });
  const auth = (t: ReturnType<typeof setup>) => t.calls.map((c) => c.headers.Authorization);

  it("routes each call to the App serving the owner, the default App taking the rest", async () => {
    const t = setup({ activeSource: "app", allowedOwners: ["*"] }, [ok(), ok(), ok()], apps);
    const a = await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x" });
    await t.proxy.rest(ctx, { method: "GET", path: "/repos/lerenn/y" });
    await t.proxy.rest(ctx, { method: "GET", path: "/repos/other/z" });
    expect(auth(t)).toEqual(["Bearer tok-org", "Bearer tok-me", "Bearer tok-rest"]);
    expect(a).toMatchObject({ source: "app", app: "App org" });
    expect(t.activity.list().map((e) => e.app)).toEqual(["App rest", "App me", "App org"]);
  });

  it("checks the owner allowlist before choosing an App", async () => {
    const t = setup({ activeSource: "app", allowedOwners: ["acme"] }, [], apps);
    await expect(t.proxy.rest(ctx, { method: "GET", path: "/repos/lerenn/y" })).rejects.toThrow(/not in the allowed owners/);
    expect(t.calls).toHaveLength(0);
    expect(t.activity.list()[0]!.app).toBeNull();
  });

  it("tracks the rate limit per App: one App limited does not block another", async () => {
    const reset = String(Math.floor((1_000_000 + 600_000) / 1000));
    const t = setup({ activeSource: "app", allowedOwners: ["*"] }, [{ status: 403, headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, body: {} }, ok(limit("4000"))], apps);
    const err = await failure(t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x" }));
    expect(err.kind).toBe("rate_limited");
    expect(err.message).toContain('GitHub App "App org"');
    await t.proxy.rest(ctx, { method: "GET", path: "/repos/lerenn/y" });
    const rows = t.proxy.overview().sources;
    expect(rows.find((s) => s.key === "app:org")!.blockedUntil).not.toBeNull();
    expect(rows.find((s) => s.key === "app:me")).toMatchObject({ blockedUntil: null, owners: ["lerenn"], limits: [{ remaining: 4000 }] });
    expect(rows.find((s) => s.key === "gh")!.limits).toEqual([]);
    expect(rows.map((s) => s.key)).toEqual(["gh", "app:org", "app:me", "app:rest"]);
  });

  it("keeps cached answers per identity: another App or gh never reads them", async () => {
    // Both Apps may be asked about the same URL only through the default App route, so use gh vs App on one owner.
    const t = setup({ activeSource: "gh", allowedOwners: ["*"] }, [ok(), ok()], apps);
    await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x" });
    t.config.activeSource = "app";
    const viaApp = await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x" });
    expect(viaApp.served).toBe("upstream");
    expect(auth(t)).toEqual(["Bearer tok-gh", "Bearer tok-org"]);
    // each identity then has its own fresh entry
    expect((await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x" })).served).toBe("cache");
    t.config.activeSource = "gh";
    expect((await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x" })).served).toBe("cache");
    expect(t.calls).toHaveLength(2);
    expect(new Set([...t.cache["entries"].keys()]).size).toBe(2);
  });

  it("does not serve a stale answer cached under an identity the call cannot use", async () => {
    const t = setup({ activeSource: "gh", allowedOwners: ["*"] }, [ok()], apps);
    await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x" });
    t.tracker.block("app:org", 9_999_999);
    t.config.activeSource = "app";
    t.advance(60_000);
    await expect(t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x" })).rejects.toThrow(/rate limit/);
  });

  it("falls back from an App to gh when enabled, and names the owner when no App serves it", async () => {
    const t = setup({ activeSource: "app", fallbackOnRateLimit: true, allowedOwners: ["*"] }, [{ status: 429, headers: { "retry-after": "60" }, body: {} }, ok()], [app("org", ["acme"])]);
    const r = await t.proxy.rest(ctx, { method: "GET", path: "/repos/acme/x" });
    expect(r).toMatchObject({ source: "gh", app: null });
    expect(auth(t)).toEqual(["Bearer tok-org", "Bearer tok-gh"]);
    // no default App: another owner has no App, falls back to gh at once
    const other = await t.proxy.rest(ctx, { method: "GET", path: "/repos/zed/x" });
    expect(other.source).toBe("gh");
  });

  it("denies with a message naming the owner when no App serves it and there is no fallback", async () => {
    const t = setup({ activeSource: "app", allowedOwners: ["*"] }, [], [app("org", ["acme"])]);
    const err = await failure(t.proxy.rest(ctx, { method: "GET", path: "/repos/zed/x" }));
    expect(err.kind).toBe("auth");
    expect(err.message).toContain('No GitHub App serves the owner "zed"');
    expect(t.calls).toHaveLength(0);
  });

  it("refuses a call spanning owners of two Apps", async () => {
    const t = setup({ activeSource: "app", allowedOwners: ["*"] }, [], apps);
    const q = 'query { a: repository(owner: "acme", name: "x") { id } b: repository(owner: "lerenn", name: "y") { id } }';
    await expect(t.proxy.graphql(ctx, { query: q, repo: "acme/x" })).rejects.toThrow(/different GitHub Apps/);
    expect(t.calls).toHaveLength(0);
  });

  it("lookup through one App uses that App only", async () => {
    const t = setup({ activeSource: "gh", allowedOwners: ["*"] }, [ok(), ok()], apps);
    await t.proxy.lookup("/installation/repositories", { per_page: 100 }, { app: "me" });
    await t.proxy.lookup("/installation/repositories", { per_page: 100 }, { app: "org" });
    expect(auth(t)).toEqual(["Bearer tok-me", "Bearer tok-org"]);
    expect(t.calls[0]!.url).toBe(t.calls[1]!.url);
  });
});
