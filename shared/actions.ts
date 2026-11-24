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
  "create_branch",
  "write_file",
  "manage_labels",
  "manage_release",
  "manage_actions",
  "manage_variables",
  "create_repo",
  "edit_repo",
  "manage_gists",
  "manage_notifications",
  "manage_project",
  "subscribe_events",
  "generic_api_read",
  "generic_api_write",
] as const;
export type Action = (typeof ACTIONS)[number];
export const actionSchema = z.enum(ACTIONS);

export const ACTION_INFO: Record<Action, { label: string; hint: string; risk: "safe" | "low" | "medium" | "high" }> = {
  read: { label: "Read", hint: "Get and list PRs, issues, checks, branches, commits, files, releases, workflow runs and logs, labels, projects, repo info and search.", risk: "safe" },
  comment: { label: "Comment", hint: "Comment on issues and pull requests.", risk: "low" },
  review: { label: "Review", hint: "Submit a pull request review (approve, request changes, comment).", risk: "medium" },
  create_issue: { label: "Create issue", hint: "Open new issues.", risk: "low" },
  create_pr: { label: "Create PR", hint: "Open new pull requests.", risk: "low" },
  update_pr: { label: "Update PR", hint: "Edit, close, reopen, label, assign and lock pull requests and issues; mark a PR ready or draft; request reviewers; edit or delete comments.", risk: "medium" },
  merge: { label: "Merge", hint: "Merge pull requests, enable auto-merge, sync a fork with its upstream.", risk: "high" },
  delete_branch: { label: "Delete branch", hint: "Delete branches.", risk: "high" },
  force_push: { label: "Force push", hint: "Rewrite a ref with a non fast-forward update.", risk: "high" },
  create_branch: { label: "Create branch", hint: "Create branches and tags (git refs) from an existing commit.", risk: "low" },
  write_file: { label: "Write file", hint: "Create, update or delete files through the contents API. Each call is a commit on a branch.", risk: "medium" },
  manage_labels: { label: "Manage labels", hint: "Create, edit and delete the labels of a repository.", risk: "low" },
  manage_release: { label: "Manage releases", hint: "Create, edit and delete releases and their assets.", risk: "high" },
  manage_actions: { label: "Manage Actions", hint: "Re-run, cancel and dispatch workflows, enable or disable them, delete runs and caches.", risk: "medium" },
  manage_variables: { label: "Manage variables and secrets", hint: "Set and delete Actions variables, delete secrets. Secret values can never be set or read.", risk: "medium" },
  create_repo: { label: "Create repository", hint: "Create or fork repositories.", risk: "medium" },
  edit_repo: { label: "Edit repository", hint: "Change a repository's description, homepage, topics and default branch; sync a fork.", risk: "medium" },
  manage_gists: { label: "Manage gists", hint: "Create, edit and delete gists.", risk: "low" },
  manage_notifications: { label: "Manage notifications", hint: "Mark notifications as read or done.", risk: "low" },
  manage_project: { label: "Manage projects", hint: "Add items to GitHub Projects and change their field values.", risk: "low" },
  subscribe_events: { label: "Subscribe to events", hint: "Ask to be woken by a GitHub event (checks done, review, comment, merge) on a repository, with github_subscribe. Needs the webhook listener. Reads nothing and changes nothing on GitHub.", risk: "low" },
  generic_api_read: { label: "Generic API (read)", hint: "github_api GET requests and GraphQL queries.", risk: "low" },
  generic_api_write: { label: "Generic API (write)", hint: "github_api writes: any non-GET REST call and GraphQL mutations.", risk: "high" },
};

export const PRESETS = ["read_only", "pr_workflow", "full"] as const;
export type Preset = (typeof PRESETS)[number];

export const PRESET_INFO: Record<Preset, { label: string; hint: string; allow: readonly Action[] }> = {
  read_only: { label: "Read-only", hint: "Agents can look but not touch. The default.", allow: ["read", "generic_api_read"] },
  pr_workflow: {
    label: "PR workflow",
    hint: "Read, comment, review, open issues and PRs and update them, create branches, manage labels and notifications. No merge, no branch deletion, no force push, no file writes, no releases, no workflow runs, no generic writes.",
    allow: ["read", "generic_api_read", "comment", "review", "create_issue", "create_pr", "update_pr", "create_branch", "manage_labels", "manage_notifications", "subscribe_events"],
  },
  full: { label: "Full", hint: "Everything is allowed. Use the rules to carve out exceptions.", allow: ACTIONS },
};
