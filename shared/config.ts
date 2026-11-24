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
  /** Lower-cased owners (users or orgs) the proxy may act on; `*` allows all. Empty refuses everything. */
  allowedOwners: z.array(z.string()).default([]),
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

/** What the client may know about the GitHub App credentials: never the key itself. */
export const appCredentialsViewSchema = z.object({
  configured: z.boolean(),
  appId: z.string(),
  installationId: z.string(),
  /** Short fingerprint of the private key, to tell two keys apart. */
  keyFingerprint: z.string(),
});
export type AppCredentialsView = z.infer<typeof appCredentialsViewSchema>;
