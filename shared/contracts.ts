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

/** Generates (`generate`) or removes (`clear`) an App's webhook secret. The new value is in the answer once and can not be read again. */
export const webhookSecretRpc = defineRpc({
  name: "github-proxy.webhook.secret",
  input: z.object({ id: z.string(), action: z.enum(["generate", "clear"]) }),
  output: z.object({ apps: z.array(appCredentialsViewSchema), secret: z.string() }),
});

export const webhookStatusRpc = defineRpc({
  name: "github-proxy.webhook.status",
  input: z.object({}),
  output: z.object({
    enabled: z.boolean(),
    listening: z.boolean(),
    port: z.number(),
    bind: z.string(),
    path: z.string(),
    error: z.string(),
    lastDeliveryAt: z.number().nullable(),
    counters: z.object({ accepted: z.number(), badSignature: z.number(), badOwner: z.number(), ignored: z.number(), duplicate: z.number() }),
    appsWithSecret: z.number(),
  }),
});

export const subscriptionViewSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentTitle: z.string(),
  repo: z.string(),
  number: z.number().nullable(),
  sha: z.string(),
  events: z.array(z.string()),
  conclusions: z.array(z.string()),
  persistent: z.boolean(),
  createdAt: z.number(),
  expiresAt: z.number(),
  fired: z.number(),
});

export const subscriptionsRpc = defineRpc({ name: "github-proxy.subscriptions", input: z.object({}), output: z.object({ subscriptions: z.array(subscriptionViewSchema) }) });
export const subscriptionRemoveRpc = defineRpc({ name: "github-proxy.subscriptions.remove", input: z.object({ id: z.string() }), output: z.object({ subscriptions: z.array(subscriptionViewSchema) }) });

export const appCredentialsClearRpc = defineRpc({ name: "github-proxy.app.clear", input: z.object({ id: z.string() }), output: z.object({ apps: z.array(appCredentialsViewSchema) }) });

export const sourceCheckRpc = defineRpc({
  name: "github-proxy.source.check",
  input: z.object({ source: z.enum(["gh", "app"]), /** The App to test, for `app`. */ app: z.string().default("") }),
  output: z.object({ ok: z.boolean(), detail: z.string(), account: z.string() }),
});

const checkStepSchema = z.object({
  id: z.enum(["key", "app", "installation", "token", "api", "owners"]),
  title: z.string(),
  status: z.enum(["ok", "warn", "fail", "skipped"]),
  detail: z.string(),
  diagnosis: z.string(),
});

/** Tests an App's connection step by step, on the saved credentials or the edited form values. Nothing is saved; an empty `privateKey` uses the stored one. */
export const appTestRpc = defineRpc({
  name: "github-proxy.app.test",
  input: z.object({
    id: z.string().default(""),
    organization: z.string().default(""),
    appId: z.string().default(""),
    installationId: z.string().default(""),
    owners: z.array(z.string()).default([]),
    privateKey: z.string().default(""),
  }),
  output: z.object({
    ok: z.boolean(),
    steps: z.array(checkStepSchema),
    installations: z.array(z.object({ id: z.string(), login: z.string(), type: z.string() })),
  }),
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
