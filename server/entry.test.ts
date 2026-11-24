import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import contribute from "../index.server";
import { activityRpc, appCredentialsClearRpc, appCredentialsSaveRpc, configGetRpc, configSaveRpc, dryRunRpc, overviewRpc, sourceCheckRpc } from "../shared/contracts";
import { defaultConfig } from "../shared/config";
import { HARD_RULE_MESSAGE } from "./hardrule";
import { SOFT_RULE_METADATA_KEY, SOFT_RULE_PROMPT } from "./tools";

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

  it("the hard rule denies a gh permission request only while it is on, and logs it", async () => {
    const { hooks, rpc } = load();
    const respond = vi.fn(async () => {});
    const ctx = { paseo: { agents: { ref: () => ({ respondToPermission: respond }) } } };
    const event = (command: string) => ({ agent: { id: "a", title: "T" }, request: { id: "r1", kind: "tool", input: { command } } });
    const hook = hooks.get("agent.permission.before")!;
    await hook(event("gh pr list"), ctx);
    expect(respond).not.toHaveBeenCalled();
    const { config } = await rpc(configGetRpc);
    await rpc(configSaveRpc, { config: { ...config, blockRawGithub: true } });
    await hook(event("git status"), ctx);
    expect(respond).not.toHaveBeenCalled();
    await hook(event("gh pr list"), ctx);
    expect(respond).toHaveBeenCalledWith({ requestId: "r1", response: { behavior: "deny", message: HARD_RULE_MESSAGE } });
    const { entries } = await rpc(activityRpc, {});
    expect(entries[0]).toMatchObject({ status: "denied", tool: "hard rule" });
  });

  it("the soft rule is also saved in a new agent's system prompt, for hosts without appendSystemPrompt", async () => {
    const { hooks, rpc } = load();
    const create = hooks.get("agent.create.before")!;
    const req = (config: object) => ({ request: { config: { provider: "claude", cwd: "/x", ...config }, metadata: { keep: 1 } } });
    expect(await create(req({}), {})).toBeUndefined();
    const { config } = await rpc(configGetRpc);
    await rpc(configSaveRpc, { config: { ...config, forbidRawGithub: true } });
    const out = await create(req({ systemPrompt: "Mail note." }), {});
    expect(out.config.systemPrompt).toBe(`Mail note.\n\n${SOFT_RULE_PROMPT}`);
    expect(out.metadata).toEqual({ keep: 1, [SOFT_RULE_METADATA_KEY]: true });
    expect((await create(req({}), {})).config.systemPrompt).toBe(SOFT_RULE_PROMPT);
    expect((await create({ request: { config: { provider: "claude", cwd: "/x", systemPrompt: SOFT_RULE_PROMPT } } }, {})).config.systemPrompt).toBe(SOFT_RULE_PROMPT);
    expect(await create(req({ internal: true }), {})).toBeUndefined();
  });

  it("does not append the soft rule at open when the agent already saved it", async () => {
    const { hooks, rpc } = load();
    const { config } = await rpc(configGetRpc);
    await rpc(configSaveRpc, { config: { ...config, forbidRawGithub: true } });
    const out = await hooks.get("agent.open.before")!({ request: request({ metadata: { [SOFT_RULE_METADATA_KEY]: true } }) }, {});
    expect(out.appendSystemPrompt).toBeUndefined();
    expect(out.tools.length).toBeGreaterThan(0);
  });

  it("config persists across a reload and never exposes secrets", async () => {
    const first = load();
    await first.rpc(configSaveRpc, { config: { ...defaultConfig(), allowedOwners: ["acme"], cacheTtlSeconds: 90 } });
    first.cleanup();
    const second = load();
    const got = await second.rpc(configGetRpc);
    expect(got.config).toMatchObject({ allowedOwners: ["acme"], cacheTtlSeconds: 90 });
    expect(got.apps).toEqual([]);
  });

  it("answers the dry run, the overview and the activity log", async () => {
    const { rpc } = load();
    await rpc(configSaveRpc, { config: { ...defaultConfig(), allowedOwners: ["acme"] } });
    expect(await rpc(dryRunRpc, { kind: "rest", method: "PUT", path: "/repos/acme/x/pulls/1/merge" })).toMatchObject({ allowed: false, actions: ["merge", "generic_api_write"] });
    expect(await rpc(dryRunRpc, { kind: "rest", method: "GET", path: "/repos/acme/x/pulls" })).toMatchObject({ allowed: true });
    expect((await rpc(overviewRpc)).sources.map((s: { source: string }) => s.source)).toEqual(["gh", "app"]);
    expect(await rpc(activityRpc, { limit: 10 })).toEqual({ entries: [] });
  });

  it("manages several Apps over RPC and never returns a private key", async () => {
    const { rpc } = load();
    const { generateKeyPairSync } = await import("node:crypto");
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
    const a = await rpc(appCredentialsSaveRpc, { organization: "Org", appId: "1", installationId: "2", owners: ["acme"], privateKey: pem });
    await rpc(appCredentialsSaveRpc, { organization: "Me", appId: "3", installationId: "4", owners: ["lerenn"], privateKey: pem });
    expect(JSON.stringify(a)).not.toContain("PRIVATE KEY");
    const got = await rpc(configGetRpc);
    expect(got.apps.map((x: { organization: string; default: boolean }) => [x.organization, x.default])).toEqual([["org", true], ["me", false]]);
    expect(JSON.stringify(got)).not.toContain("PRIVATE KEY");
    const sources = (await rpc(overviewRpc)).sources.map((s: { key: string }) => s.key);
    expect(sources).toEqual(["gh", "app:org", "app:me"]);
    expect((await rpc(sourceCheckRpc, { source: "app", app: "nope" })).ok).toBe(false);
    const after = await rpc(appCredentialsClearRpc, { id: a.id });
    expect(after.apps.map((x: { organization: string }) => x.organization)).toEqual(["me"]);
  });
});
