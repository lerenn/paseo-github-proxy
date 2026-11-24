# Policy action migration

**Status:** Accepted

## Context

A policy stores its allowed actions as a list. When a release adds an action, a policy saved earlier lacks it, so the action is denied even where the user allows the closest existing one. A subagent that could open pull requests was denied `create_branch` (added in 0.5.0) and stopped. Denial messages also did not say how to fix it.

## Decision

- The policy records `actionsVersion`, the action catalog version it was saved at (1 when absent). `shared/actions.ts` holds `CATALOG_VERSION`, `ACTION_SINCE` and `IMPLIED_BY`.
- On load, `migratePolicy` adds each action newer than the stored version wherever an implying action is present, in the default permissions and in every rule that lists actions (so a deny rule for `create_pr` also denies `create_branch`). Rules for all actions are left alone. The result is saved and stamped with the current version; saving from the Policy tab stamps it too, so an uncheck is never undone.
- Mapping: `create_branch` by `create_pr`; `manage_labels` by `update_pr`; `subscribe_events` by `comment`. Nothing else is implied: `write_file`, `manage_release`, `manage_actions`, `manage_variables`, `create_repo`, `edit_repo`, `manage_gists`, `manage_notifications`, `manage_project` stay denied until checked.
- Policy denials name the action, the rule or default policy, and say to enable the action in the Policy tab; for `create_branch` and `write_file` they add that plain git is not affected.

## Consequences

Upgrades no longer break existing workflows, and never widen a policy beyond what an existing grant already implies. A new action must declare its `since` version, and its implication (or none) in `IMPLIED_BY`.
