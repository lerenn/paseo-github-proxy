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
import { appKey } from "./server/apps";
import { discoverOwners, discoverRepos } from "./server/discovery";
import { createHardRuleHandler } from "./server/hardrule";
import { createRuntime } from "./server/runtime";
import { buildTools, SOFT_RULE_METADATA_KEY, SOFT_RULE_PROMPT, withSoftRule } from "./server/tools";

const hostAppend = (request: object): string[] => {
  const value = (request as { appendSystemPrompt?: string[] }).appendSystemPrompt;
  return Array.isArray(value) ? value : [];
};

export default function contribute(server: PluginServerContext) {
  const rt = createRuntime();

  // Paseo before 0.17 has no `appendSystemPrompt` on session open, so with the soft rule on, a new agent also gets the
  // instruction in its saved system prompt (the way paseo-mail does) and a metadata mark. Every host: the mark keeps
  // a host that does support `appendSystemPrompt` from adding it a second time.
  server.addHook("agent.create.before", async ({ request }) => {
    try {
      if (!rt.store.get().forbidRawGithub || request.config.internal) return;
      return {
        ...request,
        config: { ...request.config, systemPrompt: withSoftRule(request.config.systemPrompt) },
        metadata: { ...request.metadata, [SOFT_RULE_METADATA_KEY]: true },
      };
    } catch (error) {
      console.error("[github-proxy] could not add the soft rule to the system prompt:", error);
      return;
    }
  });

  // Every agent gets the github_* tools; with the soft rule on, also an instruction to use them instead of gh/curl.
  // Paseo marks open sessions stale when the plugin reloads, and a changed setting applies to sessions opened afterwards.
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.purpose === "history") return;
    const { forbidRawGithub } = rt.store.get();
    // Hosts from 0.17 take per-open instructions; older ones ignore the field and rely on the saved prompt above.
    const saved = request.metadata?.[SOFT_RULE_METADATA_KEY] === true;
    return {
      ...request,
      tools: [...request.tools, ...buildTools({ proxy: rt.proxy, softRule: forbidRawGithub })],
      ...(forbidRawGithub && !saved ? { appendSystemPrompt: [...hostAppend(request), SOFT_RULE_PROMPT] } : {}),
    };
  });

  // The hard rule: a Bash permission request that runs gh, or curl/wget at GitHub, is denied. Only requests the agent
  // raises reach this hook (an agent in bypass mode raises none), and it matches command words; it is not a sandbox.
  const hardRule = createHardRuleHandler({ enabled: () => rt.store.get().blockRawGithub, log: (entry) => rt.activity.add(entry) });
  server.addHook("agent.permission.before", async (event, context) => {
    try {
      await hardRule(event, (message) =>
        context.paseo.agents.ref(event.agent.id).respondToPermission({ requestId: event.request.id, response: { behavior: "deny", message } }),
      );
    } catch (error) {
      console.error("[github-proxy] hard rule failed:", error);
    }
  });

  server.handle(overviewRpc, () => rt.proxy.overview());
  server.handle(configGetRpc, () => ({ config: rt.store.get(), apps: rt.store.appViews() }));
  server.handle(configSaveRpc, ({ config }) => ({ config: rt.store.set(config) }));
  server.handle(appCredentialsSaveRpc, (input) => {
    const id = rt.store.saveApp(input);
    rt.apps.forget(id);
    rt.tracker.clear(appKey(id));
    return { apps: rt.store.appViews(), id };
  });
  server.handle(appCredentialsClearRpc, ({ id }) => {
    rt.store.removeApp(id);
    rt.apps.forget(id);
    rt.tracker.clear(appKey(id));
    return { apps: rt.store.appViews() };
  });
  server.handle(sourceCheckRpc, async ({ source, app }) => {
    if (source === "gh") {
      rt.gh.invalidate();
      const status = await rt.gh.status();
      return { ok: status.ok, detail: status.detail, account: status.user };
    }
    const entry = rt.store.apps().find((a) => a.id === app);
    if (!entry) return { ok: false, detail: "That GitHub App is not saved yet. Save it first.", account: "" };
    try {
      rt.apps.forget(entry.id);
      await rt.apps.source(entry.id).token();
      return { ok: true, detail: "GitHub accepted the App credentials and issued an installation token.", account: `${entry.label} (App ${entry.appId})` };
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
  const lookup = (path: string, query?: Record<string, string | number>, via?: { app: string }) => rt.proxy.lookup(path, query, via);
  server.handle(discoverOwnersRpc, () => discoverOwners(lookup, rt.store.get().activeSource, rt.store.apps()));
  server.handle(discoverReposRpc, async () => {
    const config = rt.store.get();
    const apps = rt.store.apps();
    const { owners } = config.allowedOwners.includes("*") ? await discoverOwners(lookup, config.activeSource, apps) : { owners: [] };
    return discoverRepos(lookup, config, owners, apps);
  });
  server.handle(dryRunRpc, ({ kind, method, path, query, repo }) =>
    rt.proxy.dryRun(kind === "graphql" ? { kind, query, repo } : { kind, method, path }),
  );

  return () => rt.dispose();
}
