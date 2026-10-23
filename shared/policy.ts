import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Write operations the policy distinguishes. */
export const OPERATIONS = [
  "comment",
  "comment.delete",
  "pr.create",
  "pr.update",
  "pr.close",
  "pr.merge",
  "label",
  "review.request",
  "review.submit",
  "issue.create",
  "issue.update",
  "branch.delete",
  /** Repository, organization and security settings: hooks, collaborators, secrets, protection, deletion. */
  "admin",
  /** Any write the proxy cannot classify. */
  "other",
] as const;
export const operationSchema = z.enum(OPERATIONS);
export type Operation = z.infer<typeof operationSchema>;

/** Allowed unless a rule denies it. Everything else, merges and admin included, is refused. */
export const DEFAULT_ALLOW: Operation[] = ["comment", "pr.create", "label", "review.request"];

export const repoRuleSchema = z.object({
  /** `owner/name`, `owner/*` or `*`. Case-insensitive. */
  repo: z.string().trim().min(1).regex(/^(\*|[\w.-]+\/(\*|[\w.-]+))$/, "use owner/name, owner/* or *"),
  /** Operations this rule adds to the allowed set. */
  allow: z.array(operationSchema).default([]),
  /** Operations refused for matching repositories, whatever else allows them. */
  deny: z.array(operationSchema).default([]),
});
export type RepoRule = z.output<typeof repoRuleSchema>;

export const policySchema = z.object({
  allow: z.array(operationSchema).default(DEFAULT_ALLOW),
  deny: z.array(operationSchema).default([]),
  repos: z.array(repoRuleSchema).default([]),
});
export type Policy = z.output<typeof policySchema>;

export const policySettings = defineSettings({
  id: "policy",
  scope: "host",
  version: 1,
  schema: policySchema,
});
