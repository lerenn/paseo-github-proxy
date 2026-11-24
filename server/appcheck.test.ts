import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testAppConnection } from "./appcheck";
import { AppSource, diagnose, type FetchFn } from "./auth";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

type Route = [string, number, unknown];
const fake = (routes: Route[]): { fetch: FetchFn; calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const path = url.replace("https://api.github.com", "");
      calls.push(`${init.method} ${path}`);
      const r = routes.find(([k]) => k === `${init.method} ${path}`);
      const [, status, body] = r ?? ["", 500, {}];
      return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    },
  };
};
const input = { organization: "acme", appId: "1", installationId: "9", owners: [], privateKey };
const good: Route[] = [
  ["GET /app", 200, { name: "Proxy", slug: "proxy", permissions: { issues: "write" } }],
  ["GET /app/installations/9", 200, { account: { login: "Acme", type: "Organization" }, permissions: { issues: "write" }, repository_selection: "all" }],
  ["POST /app/installations/9/access_tokens", 201, { token: "ghs_SECRET", expires_at: "2026-01-01T00:00:00Z" }],
  ["GET /rate_limit", 200, { resources: { core: { limit: 5000, remaining: 4990 } } }],
];

describe("testAppConnection", () => {
  it("passes every step and never exposes the token or key", async () => {
    const r = await testAppConnection(input, { fetch: fake(good).fetch });
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
    expect(r.steps[4]!.detail).toContain("4990 of 5000");
    const dump = JSON.stringify(r);
    expect(dump).not.toContain("ghs_SECRET");
    expect(dump).not.toContain("BEGIN PRIVATE KEY");
  });
  it("reports a bad key and sends nothing", async () => {
    const f = fake(good);
    const r = await testAppConnection({ ...input, privateKey: "nope" }, { fetch: f.fetch });
    expect(r.steps[0]!.status).toBe("fail");
    expect(r.steps[1]!.status).toBe("skipped");
    expect(f.calls).toEqual([]);
  });
  it("diagnoses a 401 on the App", async () => {
    const r = await testAppConnection(input, { fetch: fake([["GET /app", 401, {}]]).fetch });
    expect(r.ok).toBe(false);
    expect(r.steps[1]!.diagnosis).toMatch(/key|clock/);
    expect(r.steps[2]!.status).toBe("skipped");
  });
  it("on a 404 installation explains it and lists the real installations", async () => {
    const r = await testAppConnection(input, {
      fetch: fake([good[0]!, ["GET /app/installations/9", 404, {}], ["GET /app/installations?per_page=100", 200, [{ id: 77, account: { login: "acme", type: "Organization" } }]]]).fetch,
    });
    expect(r.steps[2]!.status).toBe("fail");
    expect(r.steps[2]!.diagnosis).toContain("does not belong to this App");
    expect(r.installations).toEqual([{ id: "77", login: "acme", type: "Organization" }]);
    expect(r.steps[3]!.status).toBe("skipped");
  });
  it("fails on a refused token with the 403 diagnosis", async () => {
    const r = await testAppConnection(input, { fetch: fake([...good.slice(0, 2), ["POST /app/installations/9/access_tokens", 403, {}]]).fetch });
    expect(r.steps[3]!.status).toBe("fail");
    expect(r.steps[3]!.diagnosis).toMatch(/suspended|permission/);
  });
  it("warns when the organization or owners do not match the installation", async () => {
    const r = await testAppConnection({ ...input, organization: "other", owners: ["third"] }, { fetch: fake(good).fetch });
    expect(r.ok).toBe(true);
    expect(r.steps[5]!.status).toBe("warn");
    expect(r.steps[5]!.detail).toContain('"other"');
    expect(r.steps[5]!.detail).toContain("third");
  });
  it("reports a network failure", async () => {
    const r = await testAppConnection(input, { fetch: async () => Promise.reject(new Error("offline")) });
    expect(r.steps[1]!.detail).toContain("offline");
  });
});

describe("runtime error message", () => {
  it("explains a 404 without secrets", async () => {
    const source = new AppSource(() => ({ appId: "1", installationId: "9", privateKey }), async () => ({ status: 404, headers: { get: () => null }, text: async () => "{}" }));
    const error = await source.token().catch((e: Error) => e);
    expect((error as Error).message).toMatch(/HTTP 404.*installation id does not belong to this App.*Do not retry/);
    expect((error as Error).message).not.toContain("PRIVATE");
    expect(diagnose(401, "token")).toMatch(/clock/);
  });
});
