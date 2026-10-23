import { execFile, spawnSync } from "node:child_process";
import { chmodSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProxyHttp } from "./http";
import { McpServer } from "./mcp";
import { SessionStore } from "./sessions";
import { SHIM_SCRIPT } from "./shim-script";
import { fakeGithub, standardRoutes, tmp } from "./testing";
import { readTools } from "./tools";

const exec = promisify(execFile);
let http: ProxyHttp;
let url: string;
let capability: string;
let shim: string;
const hasJq = spawnSync("jq", ["--version"]).status === 0;

beforeAll(async () => {
  const { client } = fakeGithub(standardRoutes as never);
  const dir = tmp();
  const sessions = new SessionStore(path.join(dir, "sessions.json"));
  capability = sessions.create("/nowhere");
  http = new ProxyHttp({ client, sessions, mcp: new McpServer(readTools) });
  url = await http.start(0);
  shim = path.join(dir, "gh");
  writeFileSync(shim, SHIM_SCRIPT);
  chmodSync(shim, 0o755);
});
afterAll(() => http.stop());

const post = (p: string, body: unknown, token: string | null = capability, headers: Record<string, string> = {}) =>
  fetch(url + p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });

describe("ProxyHttp", () => {
  it("rejects missing or unknown capabilities", async () => {
    expect((await post("/mcp", {}, null)).status).toBe(401);
    expect((await post("/mcp", {}, "wrong")).status).toBe(401);
    expect((await post("/gh", { argv: [] }, "wrong")).status).toBe(401);
  });

  it("serves MCP over POST and answers notifications with 202", async () => {
    const list = (await (await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as any;
    expect(list.result.tools.length).toBeGreaterThan(0);
    expect((await post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  });

  it("only accepts POST on known paths", async () => {
    expect((await fetch(url + "/mcp")).status).toBe(405);
    expect((await fetch(url + "/other")).status).toBe(404);
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(url + "/mcp", { method: "POST", headers: { host: "evil.example", authorization: `Bearer ${capability}` } }, (r) => resolve(r.statusCode!));
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(403);
  });

  it("rejects bad bodies", async () => {
    const res = await fetch(url + "/gh", { method: "POST", headers: { authorization: `Bearer ${capability}` }, body: "not json" });
    expect(res.status).toBe(400);
    expect((await post("/gh", { argv: [1] })).status).toBe(400);
  });
});

describe("gh shim script end to end", () => {
  const env = () => ({ ...process.env, PASEO_GITHUB_PROXY_URL: url, PASEO_GITHUB_PROXY_CAPABILITY: capability });
  const gh = (...args: string[]) => exec("node", [shim, ...args], { env: env() });

  it("runs a read through the proxy", async () => {
    const { stdout } = await gh("pr", "view", "7", "-R", "acme/app", "--json", "number,title");
    expect(JSON.parse(stdout)).toEqual({ number: 7, title: "Add thing" });
  });

  it.skipIf(!hasJq)("applies --jq locally", async () => {
    const { stdout } = await gh("pr", "view", "7", "-R", "acme/app", "--json", "title", "--jq", ".title");
    expect(stdout).toBe("Add thing\n");
  });

  it("propagates stderr and exit codes", async () => {
    const err = await gh("pr", "merge", "7").catch((e) => e);
    expect(err.code).toBe(1);
    expect(err.stderr).toContain("Writes are not available");
    const pending = await gh("pr", "checks", "7", "-R", "acme/app").catch((e) => e);
    expect(pending.code).toBe(1);
    expect(pending.stdout).toContain("ci\tpass");
  });

  it("fails clearly without configuration", async () => {
    const err = await exec("node", [shim, "pr", "view"], { env: { ...process.env, PASEO_GITHUB_PROXY_URL: "", PASEO_GITHUB_PROXY_CAPABILITY: "" } }).catch((e) => e);
    expect(err.code).toBe(1);
    expect(err.stderr).toContain("not configured");
  });

  it("fails clearly when the proxy is unreachable", async () => {
    const err = await exec("node", [shim, "pr", "view"], { env: { ...process.env, PASEO_GITHUB_PROXY_URL: "http://127.0.0.1:1", PASEO_GITHUB_PROXY_CAPABILITY: "x" } }).catch((e) => e);
    expect(err.code).toBe(1);
    expect(err.stderr).toContain("cannot reach");
  });

  it("is executable once written like the plugin does", () => {
    expect(statSync(shim).mode & 0o111).not.toBe(0);
  });
});
