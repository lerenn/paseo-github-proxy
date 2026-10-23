import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { Forwarders, targetsOf } from "./server/forwarder";
import { CallLog, recentActivity } from "./server/activity";
import { GitHubClient } from "./server/github";
import { ProxyHttp } from "./server/http";
import { applyLockout, CAPABILITY_ENV } from "./server/lockout";
import { McpServer } from "./server/mcp";
import { ProxyService } from "./server/service";
import { SessionStore } from "./server/sessions";
import { SHIM_SCRIPT } from "./server/shim-script";
import { SubscriptionManager } from "./server/subscriptions";
import { ALL_TOOLS } from "./server/tools";
import { AuditLog } from "./server/audit";
import { WriteGate } from "./server/write";
import { TokenStore } from "./server/tokens";
import { lockoutApplies } from "./shared/plugin";
import { policySchema, policySettings } from "./shared/policy";
import { activityRpc, auditRpc, cancelSubscriptionRpc, clearTokenRpc, refreshBudgetRpc, setTokenRpc, statusRpc, subscriptionsRpc } from "./shared/rpc";
import { proxySettings } from "./shared/subscriptions";

const DEFAULT_PORT = 47821;
const home = path.join(homedir(), ".paseo", "github-proxy");

export default function contribute(server: PluginServerContext) {
  const tokens = new TokenStore();
  const callLog = new CallLog();
  const client = new GitHubClient({ tokens, calls: callLog });
  const sessions = new SessionStore();
  const settings = server.registerSettings(policySettings);
  const audit = new AuditLog();
  const write = new WriteGate({
    client,
    audit,
    policy: async () => {
      const state = await settings.read();
      // An unreadable policy must not fall back to something more permissive than the defaults.
      return state.status === "ready" ? state.values : policySchema.parse({});
    },
  });
  const proxy = server.registerSettings(proxySettings);

  // The Paseo API only reaches a plugin through hook and RPC contexts. Keep the first one seen,
  // and let wake-ups wait for it, so subscriptions work as soon as any hook or RPC has run.
  let paseo: PluginHookContext["paseo"] | null = null;
  let paseoReady!: () => void;
  const hasPaseo = new Promise<void>((resolve) => (paseoReady = resolve));
  const capture = (ctx: { paseo: PluginHookContext["paseo"] } | undefined) => {
    if (ctx?.paseo && !paseo) {
      paseo = ctx.paseo;
      paseoReady();
    }
  };

  async function currentSettings() {
    const state = await proxy.read();
    // Unreadable settings fall back to the defaults, which are the narrowest lockout scope.
    return state.status === "ready" ? state.values : proxySettings.schema.parse({});
  }

  const forwarders = new Forwarders({
    client,
    token: (owner) => tokens.get(owner),
    onDelivery: (repo, delivery) => {
      const { numbers, shas } = targetsOf(delivery);
      if (numbers.length || shas.length) void subscriptions.hint(repo, numbers, shas);
    },
  });
  const subscriptions: SubscriptionManager = new SubscriptionManager({
    ctx: () => ({ client }),
    settings: currentSettings,
    forwarders,
    send: async (agentId, text) => {
      await Promise.race([hasPaseo, new Promise((_, reject) => setTimeout(() => reject(new Error("Paseo API not available yet")), 30_000))]);
      await paseo!.agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
    },
  });
  subscriptions.start();
  const http = new ProxyHttp({ client, sessions, mcp: new McpServer(ALL_TOOLS), write, subscriptions });

  let url: string | null = null;
  let startError: string | null = null;
  const service = new ProxyService(client, tokens, () => ({ url, error: startError }));

  const binDir = path.join(home, "bin");
  const emptyGhConfigDir = path.join(home, "empty-gh-config");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(emptyGhConfigDir, { recursive: true });
  writeFileSync(path.join(binDir, "gh"), SHIM_SCRIPT);
  chmodSync(path.join(binDir, "gh"), 0o755);

  // Resumed agents keep the URL they were created with, so the port has to be stable.
  const port = Number(process.env.GITHUB_PROXY_PORT ?? DEFAULT_PORT);
  const started = http.start(port).then(
    (u) => {
      url = u;
    },
    (err: Error) => {
      startError = `github-proxy cannot listen on 127.0.0.1:${port}: ${err.message}. Set GITHUB_PROXY_PORT on the daemon.`;
      console.error(startError);
    },
  );

  const removeCreate = server.before("agent.create", async ({ request }, ctx) => {
    capture(ctx);
    const scope = (await currentSettings()).lockoutScope;
    // Agents outside the scope are left exactly as they are.
    if (!lockoutApplies(scope, request.env)) return;
    await started;
    // Refuse rather than leave the agent without the proxy and without its own GitHub access.
    if (!url) throw new Error(`${startError} Create the agent without PASEO_GITHUB_PROXY=on (or with =off under scope "all") to keep its own GitHub access.`);
    return applyLockout(request, {
      url,
      capability: sessions.create(request.config.cwd),
      binDir,
      emptyGhConfigDir,
      inheritedPath: process.env.PATH,
      scope,
    });
  });
  const removeOpen = server.before("agent.session_open", ({ request }, ctx) => {
    capture(ctx);
    const capability = request.env[CAPABILITY_ENV];
    if (capability) sessions.bind(capability, request.agentId);
  });
  const removeArchived = server.on("agent.archived", ({ agent }, ctx) => {
    capture(ctx);
    sessions.forgetAgent(agent.id);
    subscriptions.dropAgent(agent.id);
  });

  server.handle(subscriptionsRpc, (_input, ctx) => {
    capture(ctx);
    return { subscriptions: subscriptions.list().reverse(), forwarders: forwarders.views() };
  });
  server.handle(cancelSubscriptionRpc, ({ id }) => {
    subscriptions.cancel(id);
    return {};
  });
  server.handle(statusRpc, (_input, ctx) => {
    capture(ctx);
    return service.status();
  });
  server.handle(activityRpc, ({ limit }) => ({ entries: recentActivity(callLog.all(), audit.recent(200), limit) }));
  server.handle(auditRpc, ({ limit }) => ({ entries: audit.recent(limit) }));
  server.handle(refreshBudgetRpc, () => service.refresh());
  server.handle(setTokenRpc, async ({ owner, token }) => {
    await service.setToken(owner, token);
    return {};
  });
  server.handle(clearTokenRpc, ({ owner }) => {
    service.clearToken(owner);
    return {};
  });

  return async () => {
    removeCreate();
    removeOpen();
    removeArchived();
    subscriptions.stop();
    await forwarders.stop();
    client.limiter.stop();
    await http.stop();
  };
}
