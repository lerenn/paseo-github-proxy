import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error plain JavaScript module, shipped as a script
import { parseAttrs, run } from "./git-credential-helper.mjs";

const input = "protocol=https\nhost=github.com\npath=acme/web.git\n\n";
const reply = (status: number, body: unknown) => vi.fn(async () => ({ status, text: async () => JSON.stringify(body) }));

describe("git credential helper protocol", () => {
  it("parses key=value lines up to the blank line", () => {
    expect(parseAttrs("protocol=https\nhost=github.com\npath=a/b.git\n\nignored=1\n")).toEqual({ protocol: "https", host: "github.com", path: "a/b.git" });
    expect(parseAttrs("password=a=b\n")).toEqual({ password: "a=b" });
  });

  it("get: asks the client API and prints username and password", async () => {
    const fetch = reply(200, { username: "x-access-token", password: "ghs_1" });
    const r = await run({ argv: ["get"], stdin: input, env: { GH_PROXY_URL: "http://127.0.0.1:8788/", GH_PROXY_TOKEN: "tok" }, fetch });
    expect(r).toEqual({ stdout: "username=x-access-token\npassword=ghs_1\n\n", stderr: "", code: 0 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("http://127.0.0.1:8788/v1/git-credential");
    expect(init.headers.authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({ protocol: "https", host: "github.com", path: "acme/web.git" });
  });

  it("store and erase do nothing; other hosts get no answer without a call", async () => {
    const fetch = reply(200, {});
    expect(await run({ argv: ["store"], stdin: `${input}username=u\npassword=p\n`, env: { GH_PROXY_URL: "http://x" }, fetch })).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(await run({ argv: ["erase"], stdin: input, env: { GH_PROXY_URL: "http://x" }, fetch })).toEqual({ stdout: "", stderr: "", code: 0 });
    expect((await run({ argv: ["get"], stdin: "protocol=https\nhost=gitlab.com\npath=a/b\n\n", env: { GH_PROXY_URL: "http://x" }, fetch })).stdout).toBe("");
    expect((await run({ argv: ["get"], stdin: "protocol=https\nhost=github.com\n\n", env: { GH_PROXY_URL: "http://x" }, fetch })).stdout).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a repository the plugin does not serve gets no answer, so git tries the next helper", async () => {
    const r = await run({ argv: ["get"], stdin: input, env: { GH_PROXY_URL: "http://x" }, fetch: reply(404, { error: "not_served" }) });
    expect(r).toEqual({ stdout: "", stderr: "", code: 0 });
  });

  it("a refusal says why on stderr and tells git to quit instead of prompting", async () => {
    const r = await run({ argv: ["get"], stdin: input, env: { GH_PROXY_URL: "http://x" }, fetch: reply(403, { error: "policy_denied", message: "Denied by rule #1. Do not retry." }) });
    expect(r.stdout).toBe("quit=1\n");
    expect(r.stderr).toMatch(/Denied by rule #1/);
    expect(r.code).toBe(0);
    const off = await run({ argv: ["get"], stdin: input, env: {}, fetch: reply(200, {}) });
    expect(off.stdout).toBe("quit=1\n");
    expect(off.stderr).toMatch(/GH_PROXY_URL/);
    const down = await run({ argv: ["get"], stdin: input, env: { GH_PROXY_URL: "http://x" }, fetch: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) });
    expect(down.stderr).toMatch(/unreachable.*ECONNREFUSED/);
  });

  it("runs as a script: stdin in, stdout out", () => {
    const r = spawnSync(process.execPath, [new URL("./git-credential-helper.mjs", import.meta.url).pathname, "store"], { input, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});
