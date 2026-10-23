import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GitHubClient } from "./server/github";
import { ProxyHttp } from "./server/http";
import { applyLockout, CAPABILITY_ENV } from "./server/lockout";
import { McpServer } from "./server/mcp";
import { ProxyService } from "./server/service";
import { SessionStore } from "./server/sessions";
import { SHIM_SCRIPT } from "./server/shim-script";
import { ALL_TOOLS } from "./server/tools";
import { AuditLog } from "./server/audit";
import { WriteGate } from "./server/write";
import { TokenStore } from "./server/tokens";
import { isOptedOut } from "./shared/plugin";
import { policySchema, policySettings } from "./shared/policy";
import { auditRpc, clearTokenRpc, refreshBudgetRpc, setTokenRpc, statusRpc } from "./shared/rpc";

const DEFAULT_PORT = 47821;
const home = path.join(homedir(), ".paseo", "github-proxy");

export default function contribute(server: PluginServerContext) {
  const tokens = new TokenStore();
  const client = new GitHubClient({ tokens });
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
  const http = new ProxyHttp({ client, sessions, mcp: new McpServer(ALL_TOOLS), write });

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

  const removeCreate = server.before("agent.create", async ({ request }) => {
    if (isOptedOut(request.env)) return;
    await started;
    // Refuse rather than leave the agent without the proxy and without its own GitHub access.
    if (!url) throw new Error(`${startError} Create the agent with PASEO_GITHUB_PROXY=off to keep its own GitHub access.`);
    return applyLockout(request, {
      url,
      capability: sessions.create(request.config.cwd),
      binDir,
      emptyGhConfigDir,
      inheritedPath: process.env.PATH,
    });
  });
  const removeOpen = server.before("agent.session_open", ({ request }) => {
    const capability = request.env[CAPABILITY_ENV];
    if (capability) sessions.bind(capability, request.agentId);
  });
  const removeArchived = server.on("agent.archived", ({ agent }) => sessions.forgetAgent(agent.id));

  server.handle(statusRpc, () => service.status());
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
    client.limiter.stop();
    await http.stop();
  };
}
