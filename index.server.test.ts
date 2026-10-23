import { statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tmp } from "./server/testing";

type Handler = (input: any, ctx?: any) => any;
const before = new Map<string, Handler>();
const on = new Map<string, Handler>();
const rpcs = new Map<string, Handler>();
let cleanup: () => Promise<void> | void;
let home: string;

beforeAll(async () => {
  home = tmp();
  vi.stubEnv("HOME", home);
  vi.stubEnv("GITHUB_PROXY_PORT", "0");
  const { default: contribute } = await import("./index.server");
  cleanup = contribute({
    before: (name: string, h: Handler) => (before.set(name, h), () => before.delete(name)),
    on: (name: string, h: Handler) => (on.set(name, h), () => on.delete(name)),
    registerSettings: (def: { id: string }) => ({
      read: async () => ({ status: "ready", revision: "1", values: def.id === "policy" ? { allow: ["comment"], deny: [], repos: [] } : { webhooks: "off", pollSeconds: 60, pollSecondsWithWebhook: 300, maxTimeoutMinutes: 240 } }),
      subscribe: () => () => {},
    }),
    handle: (contract: { name: string }, h: Handler) => void rpcs.set(contract.name, h),
  } as never) as () => Promise<void>;
});
afterAll(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const create = (env?: Record<string, string>) => before.get("agent.create")!({ request: { config: { provider: "claude", cwd: "/work" }, env } }, {});

describe("plugin wiring", () => {
  it("writes an executable gh shim", () => {
    expect(statSync(path.join(home, ".paseo", "github-proxy", "bin", "gh")).mode & 0o111).not.toBe(0);
  });

  it("locks down new agents and exposes the endpoint in status", async () => {
    const out = await create({ GH_TOKEN: "secret" });
    expect(out.env.GH_TOKEN).toBe("");
    expect(out.config.mcpServers["github-proxy"].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const status = await rpcs.get("github-proxy.status")!({});
    expect(status.endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it("leaves opted-out agents untouched", async () => {
    expect(await create({ PASEO_GITHUB_PROXY: "off", GH_TOKEN: "mine" })).toBeUndefined();
  });

  it("binds a session to the agent when it opens, and forgets it on archive", async () => {
    const out = await create();
    const capability = out.env.PASEO_GITHUB_PROXY_CAPABILITY;
    await before.get("agent.session_open")!({ request: { agentId: "a1", env: { PASEO_GITHUB_PROXY_CAPABILITY: capability } } }, {});
    const url = out.env.PASEO_GITHUB_PROXY_URL;
    const call = () => fetch(`${url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${capability}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect((await call()).status).toBe(200);
    await on.get("agent.archived")!({ agent: { id: "a1" } }, {});
    expect((await call()).status).toBe(401);
  });

  it("lists subscriptions through the RPC and wakes nobody by itself", async () => {
    const out = await rpcs.get("github-proxy.subscriptions")!({}, { paseo: {} });
    expect(out).toEqual({ subscriptions: [], forwarders: [] });
  });

  it("ignores session opens without a capability", async () => {
    expect(await before.get("agent.session_open")!({ request: { agentId: "a2", env: {} } }, {})).toBeUndefined();
  });
});
