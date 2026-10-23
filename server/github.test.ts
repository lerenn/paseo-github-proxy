import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GitHubClient, GitHubError, NoTokenError } from "./github";
import { ProxyService } from "./service";
import { TokenStore } from "./tokens";

function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const tokens = new TokenStore(path.join(mkdtempSync(path.join(tmpdir(), "ghp-")), "t.json"));
  tokens.set("lerenn", "tok_lerenn");
  tokens.set("anyshift-io", "tok_any");
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {}));
  const client = new GitHubClient({ tokens, fetch: fetchMock as unknown as typeof fetch });
  return { tokens, client, fetchMock };
}
const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const auth = (init: RequestInit) => (init.headers as Record<string, string>).authorization;

describe("GitHubClient.rest", () => {
  it("authenticates with the owner's token", async () => {
    const { client, fetchMock } = setup(() => json({ ok: 1 }));
    await client.rest({ owner: "lerenn", path: "/repos/lerenn/x" });
    await client.rest({ owner: "Anyshift-io", path: "/repos/anyshift-io/y" });
    expect(auth(fetchMock.mock.calls[0][1]!)).toBe("Bearer tok_lerenn");
    expect(auth(fetchMock.mock.calls[1][1]!)).toBe("Bearer tok_any");
  });

  it("fails without a token for the owner", async () => {
    const { client, fetchMock } = setup(() => json({}));
    await expect(client.rest({ owner: "nobody", path: "/x" })).rejects.toBeInstanceOf(NoTokenError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revalidates with If-None-Match and serves the cached body on 304", async () => {
    const { client, fetchMock } = setup((_url, init) =>
      (init.headers as Record<string, string>)["if-none-match"] === '"v1"'
        ? new Response(null, { status: 304 })
        : json({ title: "PR" }, { etag: '"v1"' }),
    );
    const a = await client.rest({ owner: "lerenn", path: "/repos/lerenn/x/pulls/1" });
    const b = await client.rest({ owner: "lerenn", path: "/repos/lerenn/x/pulls/1" });
    expect(a.cached).toBe(false);
    expect(b).toMatchObject({ cached: true, data: { title: "PR" }, status: 200 });
    expect(client.cache.stats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not share cache entries between tokens", async () => {
    const { client } = setup(() => json({}, { etag: '"e"' }));
    await client.rest({ owner: "lerenn", path: "/user" });
    const other = await client.rest({ owner: "anyshift-io", path: "/user" });
    expect(other.cached).toBe(false);
    expect(client.cache.stats().entries).toBe(2);
  });

  it("skips the cache with fresh", async () => {
    const { client, fetchMock } = setup(() => json({}, { etag: '"e"' }));
    await client.rest({ owner: "lerenn", path: "/user" });
    await client.rest({ owner: "lerenn", path: "/user", fresh: true });
    expect((fetchMock.mock.calls[1][1]!.headers as Record<string, string>)["if-none-match"]).toBeUndefined();
  });

  it("sends JSON bodies for writes and never caches them", async () => {
    const { client, fetchMock } = setup(() => json({ id: 5 }, { etag: '"e"' }, 201));
    const res = await client.rest({ owner: "lerenn", method: "POST", path: "/repos/lerenn/x/issues/1/comments", body: { body: "hi" } });
    expect(res.status).toBe(201);
    expect(fetchMock.mock.calls[0][1]!.body).toBe('{"body":"hi"}');
    expect(client.cache.stats().entries).toBe(0);
  });

  it("raises GitHubError with the API message and never leaks the token", async () => {
    const { client } = setup(() => json({ message: "Not Found tok_lerenn" }, {}, 404));
    const err = await client.rest({ owner: "lerenn", path: "/repos/lerenn/missing" }).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(404);
    expect(err.message).toContain("Not Found");
    expect(err.message).not.toContain("tok_lerenn");
  });

  it("follows Link headers in restAll", async () => {
    const { client, fetchMock } = setup((url) =>
      url.includes("page=2")
        ? json([3])
        : json([1, 2], { link: '<https://api.github.com/repos/lerenn/x/pulls?page=2>; rel="next", <https://api.github.com/x?page=2>; rel="last"' }),
    );
    expect(await client.restAll({ owner: "lerenn", path: "/repos/lerenn/x/pulls" })).toEqual([1, 2, 3]);
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.github.com/repos/lerenn/x/pulls?page=2");
  });
});

describe("GitHubClient.graphql", () => {
  it("posts the query and returns data", async () => {
    const { client, fetchMock } = setup(() => json({ data: { viewer: { login: "a" } } }));
    const data = await client.graphql<{ viewer: { login: string } }>({ owner: "lerenn", query: "{ viewer { login } }" });
    expect(data.viewer.login).toBe("a");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/graphql");
  });
  it("throws when there are errors and no data", async () => {
    const { client } = setup(() => json({ errors: [{ message: "boom" }] }));
    await expect(client.graphql({ owner: "lerenn", query: "{x}" })).rejects.toThrow("boom");
  });
});

describe("ProxyService", () => {
  const rateLimit = json({ resources: { core: { limit: 5000, remaining: 4900, reset: Math.floor(Date.now() / 1000) + 3000 } } });

  it("validates a token against /rate_limit and seeds the budget", async () => {
    const { client, tokens } = setup(() => rateLimit.clone());
    const service = new ProxyService(client, tokens);
    await service.setToken("newowner", "tok_new");
    expect(tokens.has("newowner")).toBe(true);
    const status = service.status().owners.find((o) => o.owner === "newowner")!;
    expect(status.budget.resources.find((r) => r.resource === "core")!.remaining).toBe(4900);
  });

  it("does not keep a rejected token and restores the previous one", async () => {
    const { client, tokens } = setup(() => json({ message: "Bad credentials" }, {}, 401));
    const service = new ProxyService(client, tokens);
    await expect(service.setToken("fresh", "tok_bad")).rejects.toThrow("rejected");
    expect(tokens.has("fresh")).toBe(false);
    await expect(service.setToken("lerenn", "tok_bad2")).rejects.toThrow();
    expect(tokens.get("lerenn")).toBe("tok_lerenn");
  });

  it("reports owners that share a token, and one budget", async () => {
    const { client, tokens } = setup(() => rateLimit.clone());
    tokens.set("second", "tok_lerenn");
    const service = new ProxyService(client, tokens);
    await service.refresh();
    const s = service.status();
    expect(s.owners.find((o) => o.owner === "lerenn")!.sharesBudgetWith).toEqual(["second"]);
    expect(s.owners.find((o) => o.owner === "second")!.budget.resources[0].remaining).toBe(4900);
  });

  it("never exposes tokens in status", () => {
    const { client, tokens } = setup(() => json({}));
    expect(JSON.stringify(new ProxyService(client, tokens).status())).not.toContain("tok_");
  });
});
