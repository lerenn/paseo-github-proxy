import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GitHubClient } from "./server/github";
import { ProxyService } from "./server/service";
import { TokenStore } from "./server/tokens";
import { clearTokenRpc, refreshBudgetRpc, setTokenRpc, statusRpc } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const tokens = new TokenStore();
  const client = new GitHubClient({ tokens });
  const service = new ProxyService(client, tokens);

  server.handle(statusRpc, () => service.status());
  server.handle(refreshBudgetRpc, () => service.refresh());
  server.handle(setTokenRpc, async ({ owner, token }) => {
    await service.setToken(owner, token);
    return {};
  });
  server.handle(clearTokenRpc, ({ owner }) => {
    service.clearToken(owner);
    return {};
  });

  return () => client.limiter.stop();
}
