import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AppSource, AuthError, chooseSources, createAppJwt, GhCliSource, type FetchFn } from "./auth";
import { RateLimitTracker } from "./ratelimit";

// A throwaway key generated for the test: no real credential is involved.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

describe("createAppJwt", () => {
  it("signs an RS256 JWT with iss, a backdated iat and a short exp", () => {
    const jwt = createAppJwt("123", privateKey, 1_700_000_000_000);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(payload).toEqual({ iat: 1_699_999_940, exp: 1_700_000_540, iss: "123" });
    const verify = createVerify("RSA-SHA256");
    verify.update(`${h}.${p}`);
    expect(verify.verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });
});

describe("GhCliSource", () => {
  it("reads and caches the token of `gh auth token`", async () => {
    const exec = vi.fn(async () => ({ stdout: "gho_abc\n", stderr: "" }));
    let now = 0;
    const s = new GhCliSource(exec, () => now);
    expect(await s.token()).toBe("gho_abc");
    await s.token();
    expect(exec).toHaveBeenCalledTimes(1);
    now = 301_000;
    await s.token();
    expect(exec).toHaveBeenCalledTimes(2);
  });
  it("explains a missing or logged-out gh", async () => {
    const missing = new GhCliSource(async () => Promise.reject(Object.assign(new Error("x"), { code: "ENOENT" })));
    await expect(missing.token()).rejects.toThrow(/not installed/);
    const out = new GhCliSource(async () => Promise.reject(new Error("exit 1")));
    await expect(out.token()).rejects.toBeInstanceOf(AuthError);
    expect((await out.status()).ok).toBe(false);
  });
});

describe("AppSource", () => {
  const creds = { appId: "1", installationId: "9", privateKey };
  const res = (status: number, body: unknown) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

  it("exchanges the JWT for an installation token and reuses it until near expiry", async () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const fetchFn = vi.fn<FetchFn>(async () => res(201, { token: "ghs_x", expires_at: "2026-01-01T01:00:00Z" }));
    const s = new AppSource(() => creds, fetchFn, () => now);
    expect(await s.token()).toBe("ghs_x");
    expect(fetchFn.mock.calls[0]![0]).toBe("https://api.github.com/app/installations/9/access_tokens");
    expect(fetchFn.mock.calls[0]![1].headers.Authorization).toMatch(/^Bearer ey/);
    await s.token();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now += 56 * 60_000; // inside the last five minutes
    await s.token();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("shares one exchange between concurrent calls", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => res(201, { token: "t", expires_at: "2099-01-01T00:00:00Z" }));
    const s = new AppSource(() => creds, fetchFn);
    await Promise.all([s.token(), s.token(), s.token()]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("fails clearly when unconfigured, refused, or the key is bad, without echoing the key", async () => {
    expect(new AppSource(() => null, vi.fn()).configured()).toBe(false);
    await expect(new AppSource(() => null, vi.fn()).token()).rejects.toThrow(/not configured/);
    await expect(new AppSource(() => null, vi.fn(), Date.now, "https://api.github.com", () => 'GitHub App "org"').token()).rejects.toThrow(/GitHub App "org"/);
    await expect(new AppSource(() => creds, async () => res(401, { message: "Bad" })).token()).rejects.toThrow(/refused.*401/);
    const bad = new AppSource(() => ({ ...creds, privateKey: "nope" }), vi.fn());
    await expect(bad.token()).rejects.toThrow(/not a valid PEM/);
    await bad.token().catch((e: Error) => expect(e.message).not.toContain("nope"));
  });
});

describe("chooseSources", () => {
  const cand = (key: string, configured = true) => ({ key, configured });
  const base = { resource: "core" };
  it("uses the candidates in order", () => {
    const tracker = new RateLimitTracker(() => 0);
    expect(chooseSources({ ...base, candidates: [cand("gh")], tracker }).order).toEqual(["gh"]);
    expect(chooseSources({ ...base, candidates: [cand("app:a"), cand("gh")], tracker }).order).toEqual(["app:a", "gh"]);
  });
  it("skips a rate-limited credential and reports it when nothing is left", () => {
    const tracker = new RateLimitTracker(() => 0);
    tracker.block("gh", 10_000);
    expect(chooseSources({ ...base, candidates: [cand("gh"), cand("app:a")], tracker }).order).toEqual(["app:a"]);
    const off = chooseSources({ ...base, candidates: [cand("gh")], tracker });
    expect(off.order).toEqual([]);
    expect(off.blocked).toEqual({ reason: "rate_limited", until: 10_000, key: "gh" });
  });
  it("a limit on one App leaves the other Apps usable", () => {
    const tracker = new RateLimitTracker(() => 0);
    tracker.block("app:a", 10_000);
    expect(chooseSources({ ...base, candidates: [cand("app:a")], tracker }).blocked?.reason).toBe("rate_limited");
    expect(chooseSources({ ...base, candidates: [cand("app:b")], tracker }).order).toEqual(["app:b"]);
  });
  it("reports the earliest reset when both are limited, and unconfigured credentials", () => {
    const tracker = new RateLimitTracker(() => 0);
    tracker.block("gh", 10_000);
    tracker.block("app:a", 5_000);
    expect(chooseSources({ ...base, candidates: [cand("gh"), cand("app:a")], tracker }).blocked).toMatchObject({ until: 5_000 });
    const none = chooseSources({ ...base, candidates: [cand("app:", false)], tracker: new RateLimitTracker(() => 0) });
    expect(none.blocked?.reason).toBe("unconfigured");
  });
});
