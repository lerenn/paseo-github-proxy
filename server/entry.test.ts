import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import contribute from "../index.server";
import { clientApiStatusRpc, clientTokenRpc, activityRpc, appCredentialsClearRpc, appCredentialsSaveRpc, subscriptionsRpc, webhookSecretRpc, webhookStatusRpc, configGetRpc, configSaveRpc, dryRunRpc, overviewRpc, sourceCheckRpc } from "../shared/contracts";
import { defaultConfig, presetPolicy } from "../shared/config";
import { HARD_RULE_MESSAGE } from "./hardrule";
import { SOFT_RULE_METADATA_KEY, SOFT_RULE_PROMPT } from "./tools";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "ghp-home-"));
  process.env.PASEO_HOME = home;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"; // no fallbacks from the machine running the tests
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
});
afterEach(() => {
  delete process.env.PASEO_HOME;
  delete process.env.GIT_CONFIG_GLOBAL;
  delete process.env.GIT_CONFIG_SYSTEM;
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
      ["github-proxy.activity", "github-proxy.app.clear", "github-proxy.app.save",
      "github-proxy.app.test", "github-proxy.clear", "github-proxy.client-api.status", "github-proxy.client-api.token", "github-proxy.config.get", "github-proxy.config.save", "github-proxy.discover.owners", "github-proxy.discover.repos", "github-proxy.dry-run", "github-proxy.overview", "github-proxy.source.check", "github-proxy.subscriptions", "github-proxy.subscriptions.remove", "github-proxy.webhook.secret", "github-proxy.webhook.status"].sort(),
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

  it("client API: injects nothing while off, then the proxy URL, token and git helper for sessions opened after", async () => {
    const { hooks, rpc, cleanup } = load();
    const hook = hooks.get("agent.open.before")!;
    expect((await hook({ request: request() }, {})).env).toEqual({});
    const { config } = await rpc(configGetRpc);
    expect(config.clientApi).toEqual({ enabled: false, port: 8788, bind: "127.0.0.1", injectEnv: true });
    const { token } = await rpc(clientTokenRpc, { action: "generate" });
    expect(token).toMatch(/^pgp_[0-9a-f]{48}$/);
    await rpc(configSaveRpc, { config: { ...config, clientApi: { ...config.clientApi, enabled: true, port: 38788 } } });
    // gh source and no GitHub App: nothing can issue a git token, so git is left alone (and an existing GIT_CONFIG_* stays)
    const alone = (await hook({ request: request({ env: { KEEP: "1", GIT_CONFIG_COUNT: "1" } }) }, {})).env;
    expect(alone).toMatchObject({ KEEP: "1", GH_PROXY_URL: "http://127.0.0.1:38788", GH_PROXY_TOKEN: token, GIT_CONFIG_COUNT: "1" });
    expect(Object.keys(alone).filter((k) => k.startsWith("GIT_CONFIG_KEY"))).toEqual([]);
    expect(await rpc(clientApiStatusRpc)).toMatchObject({ helperFound: true, gitAvailable: false });
    // an App serves: the helper list is reset, then ours comes first, after the session's own entries
    const { generateKeyPairSync } = await import("node:crypto");
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
    await rpc(appCredentialsSaveRpc, { organization: "Org", appId: "1", installationId: "2", owners: ["acme"], privateKey: pem });
    const env = (await hook({ request: request({ env: { KEEP: "1" } }) }, {})).env;
    expect(env).toMatchObject({ KEEP: "1", GH_PROXY_URL: "http://127.0.0.1:38788", GH_PROXY_TOKEN: token, GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "credential.https://github.com.helper", GIT_CONFIG_VALUE_0: "", GIT_CONFIG_KEY_2: "credential.https://github.com.useHttpPath", GIT_CONFIG_VALUE_2: "true" });
    expect(env.GIT_CONFIG_VALUE_1).toBe(`!'${process.execPath}' '${path.join(home, "plugin-data", "lerenn", "paseo-github-proxy", "git-credential-helper.mjs")}'`);
        const appended = (await hook({ request: request({ env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c" } }) }, {})).env;
    expect(appended).toMatchObject({ GIT_CONFIG_COUNT: "4", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c", GIT_CONFIG_KEY_1: "credential.https://github.com.helper", GIT_CONFIG_VALUE_1: "" });
    expect(await hook({ request: request({ purpose: "history" }) }, {})).toBeUndefined();
    // the injection is its own switch
    await rpc(configSaveRpc, { config: { ...config, clientApi: { ...config.clientApi, enabled: true, port: 38788, injectEnv: false } } });
    expect((await hook({ request: request() }, {})).env).toEqual({});
    const status = await rpc(clientApiStatusRpc);
    expect(status).toMatchObject({ enabled: true, listening: true, port: 38788, loopback: true, tokenSet: true, helperFound: true, helperError: "" });
    // the token is in the 0600 secrets file only, never in config.json or a status answer
    const dir = path.join(home, "plugin-data", "lerenn", "paseo-github-proxy");
    expect(statSync(path.join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(dir, "secrets.json"), "utf8")).toContain(token);
    expect(readFileSync(path.join(dir, "config.json"), "utf8")).not.toContain(token);
    expect(JSON.stringify(status)).not.toContain(token);
    expect(JSON.stringify(await rpc(configGetRpc))).not.toContain(token);
    expect(await rpc(clientTokenRpc, { action: "clear" })).toEqual({ tokenSet: false, token: "" });
    cleanup();
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
    await first.rpc(configSaveRpc, { config: { ...defaultConfig(), policy: presetPolicy("read_only"), allowedOwners: ["acme"], cacheTtlSeconds: 90 } });
    first.cleanup();
    const second = load();
    const got = await second.rpc(configGetRpc);
    expect(got.config).toMatchObject({ allowedOwners: ["acme"], cacheTtlSeconds: 90 });
    expect(got.apps).toEqual([]);
  });

  it("answers the dry run, the overview and the activity log", async () => {
    const { rpc } = load();
    await rpc(configSaveRpc, { config: { ...defaultConfig(), policy: presetPolicy("read_only"), allowedOwners: ["acme"] } });
    expect(await rpc(dryRunRpc, { kind: "rest", method: "PUT", path: "/repos/acme/x/pulls/1/merge" })).toMatchObject({ allowed: false, actions: ["merge", "generic_api_write"] });
    expect(await rpc(dryRunRpc, { kind: "rest", method: "GET", path: "/repos/acme/x/pulls" })).toMatchObject({ allowed: true });
    expect((await rpc(overviewRpc)).sources.map((s: { source: string }) => s.source)).toEqual(["gh", "app"]);
    expect((await rpc(overviewRpc)).events).toMatchObject({ enabled: false, stats: { received: 0 } });
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

  it("keeps the webhook listener off by default and shows a webhook secret once", async () => {
    const { rpc } = load();
    const { generateKeyPairSync } = await import("node:crypto");
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
    expect(await rpc(webhookStatusRpc)).toMatchObject({ enabled: false, listening: false, bind: "0.0.0.0", path: "/webhook", appsWithSecret: 0 });
    const a = await rpc(appCredentialsSaveRpc, { organization: "Org", appId: "1", installationId: "2", owners: [], privateKey: pem });
    const made = await rpc(webhookSecretRpc, { id: a.id, action: "generate" });
    expect(made.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(made.apps[0].webhookSecretSet).toBe(true);
    expect(JSON.stringify(await rpc(configGetRpc))).not.toContain(made.secret);
    expect((await rpc(webhookSecretRpc, { id: a.id, action: "clear" })).apps[0].webhookSecretSet).toBe(false);
    expect((await rpc(subscriptionsRpc)).subscriptions).toEqual([]);
  });
});
