import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { actionSchema } from "./actions";
import { appCredentialsViewSchema, configSchema, policySchema } from "./config";
import { activityEntrySchema, overviewSchema } from "./state";

export const overviewRpc = defineRpc({ name: "github-proxy.overview", input: z.object({}), output: overviewSchema });

export const configGetRpc = defineRpc({
  name: "github-proxy.config.get",
  input: z.object({}),
  output: z.object({ config: configSchema, apps: z.array(appCredentialsViewSchema) }),
});

export const configSaveRpc = defineRpc({
  name: "github-proxy.config.save",
  input: z.object({ config: configSchema }),
  output: z.object({ config: configSchema }),
});

/** Adds a GitHub App (no `id`) or edits one. An empty `privateKey` keeps the stored key. */
export const appCredentialsSaveRpc = defineRpc({
  name: "github-proxy.app.save",
  input: z.object({
    id: z.string().default(""),
    /** The account the App is installed on. */
    organization: z.string().default(""),
    /** Legacy display name, kept as is for migrated Apps without an organization. */
    label: z.string().default(""),
    appId: z.string(),
    installationId: z.string(),
    owners: z.array(z.string()).default([]),
    default: z.boolean().default(false),
    privateKey: z.string().default(""),
  }),
  output: z.object({ apps: z.array(appCredentialsViewSchema), id: z.string() }),
});

export const appCredentialsClearRpc = defineRpc({ name: "github-proxy.app.clear", input: z.object({ id: z.string() }), output: z.object({ apps: z.array(appCredentialsViewSchema) }) });

export const sourceCheckRpc = defineRpc({
  name: "github-proxy.source.check",
  input: z.object({ source: z.enum(["gh", "app"]), /** The App to test, for `app`. */ app: z.string().default("") }),
  output: z.object({ ok: z.boolean(), detail: z.string(), account: z.string() }),
});

export const activityRpc = defineRpc({ name: "github-proxy.activity", input: z.object({ limit: z.number().int().min(1).max(500).default(200) }), output: z.object({ entries: z.array(activityEntrySchema) }) });

export const clearRpc = defineRpc({ name: "github-proxy.clear", input: z.object({ what: z.enum(["cache", "activity"]) }), output: z.object({ ok: z.boolean() }) });

export const dryRunRpc = defineRpc({
  name: "github-proxy.dry-run",
  input: z.object({
    kind: z.enum(["rest", "graphql"]),
    method: z.string().default("GET"),
    path: z.string().default(""),
    query: z.string().default(""),
    repo: z.string().default(""),
  }),
  output: z.object({ allowed: z.boolean(), message: z.string(), repo: z.string(), actions: z.array(actionSchema), rule: z.string().nullable() }),
});

export const discoverOwnersRpc = defineRpc({
  name: "github-proxy.discover.owners",
  input: z.object({}),
  output: z.object({ owners: z.array(z.string()), error: z.string() }),
});

export const discoverReposRpc = defineRpc({
  name: "github-proxy.discover.repos",
  input: z.object({}),
  output: z.object({ repos: z.array(z.string()), errors: z.array(z.string()) }),
});

export const policyPreviewSchema = policySchema;
