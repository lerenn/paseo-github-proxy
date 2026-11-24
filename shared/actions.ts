import { z } from "zod";

/** What a call does, from the point of view of the policy. */
export const ACTIONS = [
  "read",
  "comment",
  "review",
  "create_issue",
  "create_pr",
  "update_pr",
  "merge",
  "delete_branch",
  "force_push",
  "generic_api_read",
  "generic_api_write",
] as const;
export type Action = (typeof ACTIONS)[number];
export const actionSchema = z.enum(ACTIONS);

export const ACTION_INFO: Record<Action, { label: string; hint: string; risk: "safe" | "low" | "medium" | "high" }> = {
  read: { label: "Read", hint: "Get and list PRs, issues, checks, branches, repo info and search.", risk: "safe" },
  comment: { label: "Comment", hint: "Comment on issues and pull requests.", risk: "low" },
  review: { label: "Review", hint: "Submit a pull request review (approve, request changes, comment).", risk: "medium" },
  create_issue: { label: "Create issue", hint: "Open new issues.", risk: "low" },
  create_pr: { label: "Create PR", hint: "Open new pull requests.", risk: "low" },
  update_pr: { label: "Update PR", hint: "Edit, close or reopen pull requests and issues.", risk: "medium" },
  merge: { label: "Merge", hint: "Merge pull requests.", risk: "high" },
  delete_branch: { label: "Delete branch", hint: "Delete branches.", risk: "high" },
  force_push: { label: "Force push", hint: "Rewrite a ref with a non fast-forward update.", risk: "high" },
  generic_api_read: { label: "Generic API (read)", hint: "github_api GET requests and GraphQL queries.", risk: "low" },
  generic_api_write: { label: "Generic API (write)", hint: "github_api writes: any non-GET REST call and GraphQL mutations.", risk: "high" },
};

export const PRESETS = ["read_only", "pr_workflow", "full"] as const;
export type Preset = (typeof PRESETS)[number];

export const PRESET_INFO: Record<Preset, { label: string; hint: string; allow: readonly Action[] }> = {
  read_only: { label: "Read-only", hint: "Agents can look but not touch. The default.", allow: ["read", "generic_api_read"] },
  pr_workflow: {
    label: "PR workflow",
    hint: "Read, comment, review, open issues and PRs and update them. No merge, no branch deletion, no force push, no generic writes.",
    allow: ["read", "generic_api_read", "comment", "review", "create_issue", "create_pr", "update_pr"],
  },
  full: { label: "Full", hint: "Everything is allowed. Use the rules to carve out exceptions.", allow: ACTIONS },
};
