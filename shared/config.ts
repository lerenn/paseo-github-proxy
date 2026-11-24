import { z } from "zod";
import { ACTION_SINCE, ACTIONS, actionSchema, CATALOG_VERSION, IMPLIED_BY, PRESET_INFO, type Action } from "./actions";

export const ruleSchema = z.object({
  id: z.string(),
  effect: z.enum(["allow", "deny"]),
  /** `owner/repo` patterns: `*` matches any run of characters inside one segment, a lone `*` matches everything. */
  repos: z.array(z.string()).default(["*"]),
  /** Actions the rule covers; `*` covers all of them. */
  actions: z.array(z.union([actionSchema, z.literal("*")])).default(["*"]),
  reason: z.string().default(""),
});
export type Rule = z.infer<typeof ruleSchema>;

export const policySchema = z.object({
  preset: z.enum(["read_only", "pr_workflow", "full", "custom"]).default("read_only"),
  /** Actions allowed where no rule matches. */
  defaultAllow: z.array(actionSchema).default([...PRESET_INFO.read_only.allow]),
  rules: z.array(ruleSchema).default([]),
  /** The action catalog version the policy was last saved at; a policy without one predates versioning (1). */
  actionsVersion: z.number().int().min(1).default(1),
});
export type Policy = z.infer<typeof policySchema>;

/**
 * Brings a stored policy up to the current action catalog. An action added after the policy was saved is allowed
 * where an action that implies it is allowed (see IMPLIED_BY), in the default permissions and in each rule that
 * lists actions; a rule for all actions is left alone. The version is then stamped, so an action the user unchecks
 * later is never granted again.
 */
export function migratePolicy(policy: Policy): Policy {
  if (policy.actionsVersion >= CATALOG_VERSION) return policy;
  const added = ACTIONS.filter((a) => (ACTION_SINCE[a] ?? 1) > policy.actionsVersion && IMPLIED_BY[a]);
  const implied = (a: Action, has: (x: Action) => boolean) => IMPLIED_BY[a]!.some(has);
  const defaultAllow = [...policy.defaultAllow];
  for (const a of added) if (!defaultAllow.includes(a) && implied(a, (x) => policy.defaultAllow.includes(x))) defaultAllow.push(a);
  const rules = policy.rules.map((rule) => {
    if (rule.actions.length === 0 || rule.actions.includes("*")) return rule;
    const extra = added.filter((a) => !rule.actions.includes(a) && implied(a, (x) => rule.actions.includes(x)));
    return extra.length ? { ...rule, actions: [...rule.actions, ...extra] } : rule;
  });
  return { ...policy, defaultAllow: ACTIONS.filter((a) => defaultAllow.includes(a)), rules, actionsVersion: CATALOG_VERSION };
}

export const SOURCES = ["gh", "app"] as const;
export type SourceId = (typeof SOURCES)[number];

/** The optional webhook listener that lets GitHub push events to the plugin. Off by default. */
export const webhooksSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(8787),
  /** Address the listener binds to. Loopback by default: put a tunnel or reverse proxy in front to reach it from GitHub. */
  bind: z.string().trim().min(1).max(64).default("127.0.0.1"),
});
export type WebhooksConfig = z.infer<typeof webhooksSchema>;
export const WEBHOOK_PATH = "/webhook";

export const configSchema = z.object({
  activeSource: z.enum(SOURCES).default("gh"),
  fallbackOnRateLimit: z.boolean().default(false),
  /** Lower-cased owners (users or orgs) the proxy may act on; `*` allows all (the default). Empty refuses everything. */
  allowedOwners: z.array(z.string()).default(["*"]),
  cacheTtlSeconds: z.number().int().min(0).max(3600).default(30),
  forbidRawGithub: z.boolean().default(false),
  /** The hard rule: deny permission requests for gh, and curl or wget aimed at GitHub. Off by default. */
  blockRawGithub: z.boolean().default(false),
  webhooks: webhooksSchema.default({ enabled: false, port: 8787, bind: "127.0.0.1" }),
  policy: policySchema.default({ preset: "read_only", defaultAllow: [...PRESET_INFO.read_only.allow], rules: [], actionsVersion: CATALOG_VERSION }),
});
export type Config = z.infer<typeof configSchema>;

export function defaultConfig(): Config {
  return configSchema.parse({});
}

export function presetPolicy(preset: "read_only" | "pr_workflow" | "full", rules: Rule[] = []): Policy {
  return { preset, defaultAllow: [...PRESET_INFO[preset].allow] as Action[], rules, actionsVersion: CATALOG_VERSION };
}

/** A valid GitHub user or organization login. */
export const isOwnerName = (text: string): boolean => /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(text.trim());

/**
 * One GitHub App: its identity and the owners it serves. The private key is not here: it lives in `secrets.json`.
 *
 * `organization` is the GitHub account the App is installed on; it is claimed automatically. `owners` are the extra
 * accounts the same installation covers ("also serves"). `label` is a display name kept only for Apps saved before
 * `organization` existed whose label was not a valid account name.
 */
export const appEntrySchema = z.preprocess(
  (raw) => {
    // Apps saved before `organization` existed: the label becomes the organization only when it is a valid owner
    // name and the App claims no owner; otherwise the label stays a display name and the owners stay as they are.
    if (!raw || typeof raw !== "object" || "organization" in raw) return raw;
    const old = raw as { label?: unknown; owners?: unknown };
    const label = typeof old.label === "string" ? old.label.trim() : "";
    const noOwners = !Array.isArray(old.owners) || old.owners.length === 0;
    return label && noOwners && isOwnerName(label) ? { ...old, organization: label.toLowerCase(), label: "" } : { ...old, organization: "" };
  },
  z.object({
    /** Stable slug, kept when the organization changes. */
    id: z.string(),
    /** The account the App is installed on, lower-cased. Empty only for a migrated App that kept a display name. */
    organization: z.string().default(""),
    /** Display name when there is no organization (migrated Apps). */
    label: z.string().default(""),
    appId: z.string(),
    installationId: z.string(),
    /** Lower-cased extra owners (users or orgs) the same installation covers. */
    owners: z.array(z.string()).default([]),
    /** The default App serves every allowed owner that no App claims. */
    default: z.boolean().default(false),
  }),
);
export type AppEntry = { id: string; organization: string; label: string; appId: string; installationId: string; owners: string[]; default: boolean };

/** The name shown for an App: its organization, else the legacy label. */
export const appName = (app: Pick<AppEntry, "organization" | "label" | "id">): string => app.organization || app.label || app.id;

/** Every owner an App claims: its organization first, then the extra ones, lower-cased and without duplicates. */
export function appOwners(app: Pick<AppEntry, "organization" | "owners">): string[] {
  return [...new Set([app.organization, ...app.owners].map((o) => o.trim().toLowerCase()).filter(Boolean))];
}

/** What the client may know about one GitHub App: never the key itself. */
export const appCredentialsViewSchema = z.object({
  id: z.string(),
  organization: z.string(),
  label: z.string(),
  appId: z.string(),
  installationId: z.string(),
  owners: z.array(z.string()),
  default: z.boolean(),
  configured: z.boolean(),
  /** Whether a webhook secret is stored for this App (the value itself is never sent). */
  webhookSecretSet: z.boolean().default(false),
  /** Short fingerprint of the private key, to tell two keys apart. */
  keyFingerprint: z.string(),
});
export type AppCredentialsView = z.infer<typeof appCredentialsViewSchema>;

/** The App that serves an owner: the one claiming it, else the default one. Null when none does. */
export function resolveApp(apps: AppEntry[], owner: string): AppEntry | null {
  const o = owner.trim().toLowerCase();
  return (o ? apps.find((a) => appOwners(a).includes(o)) : undefined) ?? apps.find((a) => a.default) ?? null;
}

/**
 * The webhook events the plugin reads. GitHub sends only the events the App is subscribed to, so the user subscribes the
 * App to these (App settings, Permissions and events, Subscribe to events). The listener ignores every other event.
 */
export const WEBHOOK_EVENTS = [
  "check_run",
  "check_suite",
  "issue_comment",
  "merge_group",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "push",
  "release",
  "status",
  "workflow_run",
] as const;
/** Also read, for the cache only (no wake-up): subscribe to them to keep issue and thread reads fresh. */
export const WEBHOOK_EVENTS_CACHE_ONLY = ["issues", "pull_request_review_thread"] as const;
