import { z } from "zod";
import { actionSchema, PRESET_INFO, type Action } from "./actions";

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
});
export type Policy = z.infer<typeof policySchema>;

export const SOURCES = ["gh", "app"] as const;
export type SourceId = (typeof SOURCES)[number];

export const configSchema = z.object({
  activeSource: z.enum(SOURCES).default("gh"),
  fallbackOnRateLimit: z.boolean().default(false),
  /** Lower-cased owners (users or orgs) the proxy may act on; `*` allows all (the default). Empty refuses everything. */
  allowedOwners: z.array(z.string()).default(["*"]),
  cacheTtlSeconds: z.number().int().min(0).max(3600).default(30),
  forbidRawGithub: z.boolean().default(false),
  policy: policySchema.default({ preset: "read_only", defaultAllow: [...PRESET_INFO.read_only.allow], rules: [] }),
});
export type Config = z.infer<typeof configSchema>;

export function defaultConfig(): Config {
  return configSchema.parse({});
}

export function presetPolicy(preset: "read_only" | "pr_workflow" | "full", rules: Rule[] = []): Policy {
  return { preset, defaultAllow: [...PRESET_INFO[preset].allow] as Action[], rules };
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
  /** Short fingerprint of the private key, to tell two keys apart. */
  keyFingerprint: z.string(),
});
export type AppCredentialsView = z.infer<typeof appCredentialsViewSchema>;

/** The App that serves an owner: the one claiming it, else the default one. Null when none does. */
export function resolveApp(apps: AppEntry[], owner: string): AppEntry | null {
  const o = owner.trim().toLowerCase();
  return (o ? apps.find((a) => appOwners(a).includes(o)) : undefined) ?? apps.find((a) => a.default) ?? null;
}
