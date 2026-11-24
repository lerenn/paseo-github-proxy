import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import contribute from "../index.server";
import { activityRpc, configGetRpc, configSaveRpc, dryRunRpc, overviewRpc } from "../shared/contracts";
import { defaultConfig } from "../shared/config";
import { SOFT_RULE_PROMPT } from "./tools";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "ghp-home-"));
  process.env.PASEO_HOME = home;
});
afterEach(() => {
  delete process.env.PASEO_HOME;
  rmSync(home, { recursive: true, force: true });
});

/** A fake host: records what the plugin registers, so the wiring is exercised without a daemon. */
function load() {
  const handlers = new Map<string, (input: any) => any>();
  const hooks = new Map<string, (payload: any, ctx: any) => any>();
  const server = {
    handle: (contract: { name: string }, fn: (input: any) => any) => handlers.set(contract.name, fn),
    addHook: (name: string, fn: (payload: any, ctx: any) => any) => hooks.set(name, fn),
  } as never;
  const cleanup = contribute(server);
  const rpc = async (contract: { name: string }, input: unknown = {}) => handlers.get(contract.name)!(input);
  return { handlers, hooks, rpc, cleanup };
}

const request = (extra: object = {}) => ({ agentId: "a", workspaceId: null, provider: "claude", cwd: "/x", reason: "create", purpose: "interactive", title: null, labels: {}, metadata: {}, background: false, tools: [], env: {}, mcpServers: {}, ...extra });

describe("server entry", () => {
  it("registers every RPC and the session-open hook", () => {
    const { handlers, hooks } = load();
    expect([...handlers.keys()].sort()).toEqual(
      ["github-proxy.activity", "github-proxy.app.clear", "github-proxy.app.save", "github-proxy.clear", "github-proxy.config.get", "github-proxy.config.save", "github-proxy.discover.owners", "github-proxy.discover.repos", "github-proxy.dry-run", "github-proxy.overview", "github-proxy.source.check"].sort(),
    );
    expect(hooks.has("agent.open.before")).toBe(true);
  });

  it("adds the github tools to every agent, but not to history opens", async () => {
    const { hooks } = load();
    const hook = hooks.get("agent.open.before")!;
    const out = await hook({ request: request() }, {});
    expect(out.tools.map((t: { name: string }) => t.name)).toContain("github_api");
    expect(out.appendSystemPrompt).toBeUndefined();
    expect(await hook({ request: request({ purpose: "history" }) }, {})).toBeUndefined();
  });

  it("the soft rule, once saved, reaches the system prompt of the next session", async () => {
    const { hooks, rpc } = load();
    const { config } = await rpc(configGetRpc);
    await rpc(configSaveRpc, { config: { ...config, forbidRawGithub: true } });
    const out = await hooks.get("agent.open.before")!({ request: request({ appendSystemPrompt: ["existing"] }) }, {});
    expect(out.appendSystemPrompt).toEqual(["existing", SOFT_RULE_PROMPT]);
    expect(out.tools[0].description).toMatch(/instead of the gh CLI or curl/);
  });

  it("config persists across a reload and never exposes secrets", async () => {
    const first = load();
    await first.rpc(configSaveRpc, { config: { ...defaultConfig(), allowedOwners: ["acme"], cacheTtlSeconds: 90 } });
    first.cleanup();
    const second = load();
    const got = await second.rpc(configGetRpc);
    expect(got.config).toMatchObject({ allowedOwners: ["acme"], cacheTtlSeconds: 90 });
    expect(got.app).toEqual({ configured: false, appId: "", installationId: "", keyFingerprint: "" });
  });

  it("answers the dry run, the overview and the activity log", async () => {
    const { rpc } = load();
    await rpc(configSaveRpc, { config: { ...defaultConfig(), allowedOwners: ["acme"] } });
    expect(await rpc(dryRunRpc, { kind: "rest", method: "PUT", path: "/repos/acme/x/pulls/1/merge" })).toMatchObject({ allowed: false, actions: ["merge", "generic_api_write"] });
    expect(await rpc(dryRunRpc, { kind: "rest", method: "GET", path: "/repos/acme/x/pulls" })).toMatchObject({ allowed: true });
    expect((await rpc(overviewRpc)).sources.map((s: { source: string }) => s.source)).toEqual(["gh", "app"]);
    expect(await rpc(activityRpc, { limit: 10 })).toEqual({ entries: [] });
  });
});
