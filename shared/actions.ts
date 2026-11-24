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
  subscribe_events: { label: "Subscribe to events", hint: "Ask to be woken by a GitHub event (checks done, review, comment, merge, push, release, merge queue) on a repository, with github_subscribe. Needs the webhook listener. Reads nothing and changes nothing on GitHub.", risk: "low" },
  generic_api_read: { label: "Generic API (read)", hint: "github_api GET requests and GraphQL queries.", risk: "low" },
  generic_api_write: { label: "Generic API (write)", hint: "github_api writes: any non-GET REST call and GraphQL mutations.", risk: "high" },
};

/**
 * The catalog version a policy was last saved at. Version 1 is the original set (up to 0.4), 2 added the `gh` parity
 * actions (0.5.0), 3 added `subscribe_events` (0.7.0). Bump it, and fill ACTION_SINCE, when an action is added.
 */
export const CATALOG_VERSION = 3;
/** First catalog version that has the action. Actions absent here exist since version 1. */
export const ACTION_SINCE: Partial<Record<Action, number>> = {
  create_branch: 2, write_file: 2, manage_labels: 2, manage_release: 2, manage_actions: 2, manage_variables: 2,
  create_repo: 2, edit_repo: 2, manage_gists: 2, manage_notifications: 2, manage_project: 2,
  subscribe_events: 3,
};
/**
 * When a policy saved before an action existed is loaded, the action starts out allowed (or denied, in a rule) only
 * where one of these already is. Anything absent here (write_file, manage_release, manage_actions, manage_variables,
 * create_repo, edit_repo, manage_gists, manage_notifications, manage_project) stays denied until the user checks it.
 */
export const IMPLIED_BY: Partial<Record<Action, readonly Action[]>> = {
  create_branch: ["create_pr"], // a pull request needs a branch
  manage_labels: ["update_pr"], // update_pr already labels pull requests and issues
  subscribe_events: ["comment"], // it only wakes the agent; comment is the lightest write the user granted
};

/** Actions that have a plain git equivalent, for the denial message. */
export const PLAIN_GIT_ACTIONS: readonly Action[] = ["create_branch", "write_file"];

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
