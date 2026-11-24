import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  activityRpc,
  appCredentialsClearRpc,
  appCredentialsSaveRpc,
  clearRpc,
  configGetRpc,
  configSaveRpc,
  discoverOwnersRpc,
  discoverReposRpc,
  dryRunRpc,
  overviewRpc,
  sourceCheckRpc,
} from "./shared/contracts";
import { discoverOwners, discoverRepos } from "./server/discovery";
import { createRuntime } from "./server/runtime";
import { buildTools, SOFT_RULE_PROMPT } from "./server/tools";

export default function contribute(server: PluginServerContext) {
  const rt = createRuntime();

  // Every agent gets the github_* tools; with the soft rule on, also an instruction to use them instead of gh/curl.
  // Paseo marks open sessions stale when the plugin reloads, and a changed setting applies to sessions opened afterwards.
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.purpose === "history") return;
    const { forbidRawGithub } = rt.store.get();
    return {
      ...request,
      tools: [...request.tools, ...buildTools({ proxy: rt.proxy, softRule: forbidRawGithub })],
      ...(forbidRawGithub ? { appendSystemPrompt: [...(request.appendSystemPrompt ?? []), SOFT_RULE_PROMPT] } : {}),
    };
  });

  server.handle(overviewRpc, () => rt.proxy.overview());
  server.handle(configGetRpc, () => ({ config: rt.store.get(), app: rt.store.credentialsView() }));
  server.handle(configSaveRpc, ({ config }) => ({ config: rt.store.set(config) }));
  server.handle(appCredentialsSaveRpc, (input) => {
    rt.store.setAppCredentials(input);
    rt.app.invalidate();
    rt.tracker.clear("app");
    return { app: rt.store.credentialsView() };
  });
  server.handle(appCredentialsClearRpc, () => {
    rt.store.clearAppCredentials();
    rt.app.invalidate();
    return { app: rt.store.credentialsView() };
  });
  server.handle(sourceCheckRpc, async ({ source }) => {
    if (source === "gh") {
      rt.gh.invalidate();
      const status = await rt.gh.status();
      return { ok: status.ok, detail: status.detail, account: status.user };
    }
    try {
      rt.app.invalidate();
      await rt.app.token();
      return { ok: true, detail: "GitHub accepted the App credentials and issued an installation token.", account: `App ${rt.store.credentialsView().appId}` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message, account: "" };
    }
  });
  server.handle(activityRpc, ({ limit }) => ({ entries: rt.activity.list(limit) }));
  server.handle(clearRpc, ({ what }) => {
    if (what === "cache") rt.cache.clear();
    else rt.activity.clear();
    return { ok: true };
  });
  const lookup = (path: string, query?: Record<string, string | number>) => rt.proxy.lookup(path, query);
  server.handle(discoverOwnersRpc, () => discoverOwners(lookup, rt.store.get().activeSource));
  server.handle(discoverReposRpc, async () => {
    const config = rt.store.get();
    const { owners } = config.allowedOwners.includes("*") ? await discoverOwners(lookup, config.activeSource) : { owners: [] };
    return discoverRepos(lookup, config, owners);
  });
  server.handle(dryRunRpc, ({ kind, method, path, query, repo }) =>
    rt.proxy.dryRun(kind === "graphql" ? { kind, query, repo } : { kind, method, path }),
  );

  return () => rt.dispose();
}
