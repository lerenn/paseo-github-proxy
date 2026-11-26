# Policy reference

Order of evaluation for one call:

1. **Scope.** A request that cannot be tied to an owner (for example `/user/repos`, a search without `repo:`/`org:`/`user:`, a GraphQL call without `repo`) is denied unless `*` is an allowed owner.
2. **Allowed owners.** Every owner the call touches must be listed (exact, case-insensitive) or `*`. Default: `*` (all owners). Empty list (cleared by the user): refuse all.
3. **Actions.** The call needs every action it is classified as. For each action: a matching **deny** rule denies; else a matching **allow** rule allows; else the default permissions decide.

## Classification of `github_api`

The path is validated first (see [ADR](adrs/2026-11-26-rest-path-canonicalization.md)): dot segments, encoded dots or slashes, `//`, backslashes, `?` or `#` in the path, control or non-ASCII characters, absolute URLs and malformed owner or repository names are refused, not normalized, so the owner that is checked is the owner that is fetched. Pass the query string in `params`.

| Request | Actions needed |
| --- | --- |
| `GET`, `HEAD`, GraphQL query | `generic_api_read` |
| `POST /repos/o/r/issues` | `create_issue` + `generic_api_write` |
| `POST .../issues/N/comments`, `.../pulls/N/comments` | `comment` + `generic_api_write` |
| `POST .../pulls/N/reviews` | `review` + `generic_api_write` |
| `POST /repos/o/r/pulls` | `create_pr` + `generic_api_write` |
| `PATCH/PUT .../pulls/N`, `.../issues/N` | `update_pr` + `generic_api_write` |
| `PUT .../pulls/N/merge`, `POST .../merges` | `merge` + `generic_api_write` |
| `DELETE .../git/refs/...` | `delete_branch` + `generic_api_write` |
| `PATCH .../git/refs/...` with `force: true` | `force_push` + `generic_api_write` |
| `POST .../git/refs` | `create_branch` + `generic_api_write` |
| `PUT/DELETE .../contents/...` | `write_file` + `generic_api_write` |
| `POST/PATCH/DELETE .../labels...` | `manage_labels` + `generic_api_write` |
| writes on `.../releases...` (including assets) | `manage_release` + `generic_api_write` |
| writes on `.../actions/runs`, `jobs`, `workflows`, `caches`, `artifacts` | `manage_actions` + `generic_api_write` |
| writes on `.../actions/variables`, `.../actions/secrets`, `.../environments/E/variables`, `/secrets` (also `/orgs/o/actions/...`) | `manage_variables` + `generic_api_write` |
| `PATCH /repos/o/r`, `PUT .../topics` | `edit_repo` + `generic_api_write` |
| `POST .../forks`, `POST /orgs/o/repos`, `POST /user/repos` | `create_repo` + `generic_api_write` |
| `POST .../merge-upstream` | `merge` + `generic_api_write` |
| `POST/PUT/PATCH/DELETE` on `.../issues/N/labels`, `.../assignees`, `.../lock`, `.../pulls/N/requested_reviewers`, `.../pulls/N/update-branch`, `.../issues/comments/ID`, `.../pulls/comments/ID` | `update_pr` + `generic_api_write` |
| `POST .../pulls/N/comments/ID/replies` | `comment` + `generic_api_write` |
| writes on `/gists...` | `manage_gists` + `generic_api_write` |
| writes on `/notifications...`, `.../repos/o/r/notifications` | `manage_notifications` + `generic_api_write` |
| anything else that writes | `generic_api_write` |
| GraphQL mutation | `generic_api_write` + the action of each root field (`mergePullRequest` → `merge`, `addComment` → `comment`, `deleteRef` → `delete_branch`, `markPullRequestReadyForReview` → `update_pr`, `resolveReviewThread` → `review`, `createRef` → `create_branch`, `addProjectV2ItemById` → `manage_project`, …) |

Curated tools state their action directly and do not need `generic_api_*`. A tool with an `operation` input states one action per operation: `github_actions` needs `read` to list runs and `manage_actions` to re-run one. A curated GraphQL call (ready for review, auto-merge, review threads, projects) states its actions in the same way; its document is fixed in the plugin and is not parsed for scoping.

## Actions added for `gh` parity

| Action | Used by | Risk |
| --- | --- | --- |
| `create_branch` | `github_contents` create_branch | low |
| `write_file` | `github_contents` write, delete (a commit on a branch: deny it on repositories where an agent must not commit through the API) | medium |
| `manage_labels` | `github_labels` create, edit, delete | low |
| `manage_release` | `github_releases` create, edit, delete, delete_asset | high |
| `manage_actions` | `github_actions` rerun, cancel, dispatch, enable, disable, delete_run, delete_cache | medium |
| `manage_variables` | `github_repo_config` set_variable, delete_variable, delete_secret | medium |
| `create_repo` | `github_repo_manage` create, fork (the destination owner is checked against the allowed owners) | medium |
| `edit_repo` | `github_repo_manage` edit | medium |
| `manage_gists` | `github_gists` create, edit, delete | low |
| `manage_notifications` | `github_account` mark_read | low |
| `manage_project` | `github_project` add_item, set_field | low |
| `subscribe_events` | `github_subscribe` subscribe (list and unsubscribe only touch the agent's own subscriptions and are not checked) | low |

`update_pr` also covers labels, assignees, locking, reviewers, marking ready or draft, updating the branch, and editing or deleting comments; `merge` also covers auto-merge and syncing a fork. The PR workflow preset adds `create_branch`, `manage_labels` and `manage_notifications` to what it allowed before. `subscribe_events` is allowed by the PR workflow and Full presets and denied by Read-only. 
## Upgrading a saved policy

A policy keeps the action list it was saved with. So that a new action does not silently break a workflow the policy already allows, a policy saved before an action existed (it records the catalog version it was saved at) gets that action on first load wherever an action that implies it is allowed, in the default permissions and in each rule that lists actions (an allow rule gains it, a deny rule denies it too). Rules for all actions are untouched.

| New action | Implied by |
| --- | --- |
| `create_branch` | `create_pr` (a pull request needs a branch) |
| `manage_labels` | `update_pr` (it already labels pull requests and issues) |
| `subscribe_events` | `comment` |

Every other new action (`write_file`, `manage_release`, `manage_actions`, `manage_variables`, `create_repo`, `edit_repo`, `manage_gists`, `manage_notifications`, `manage_project`) is never implied: it stays denied until you check it. Read-only stays read-only. A fresh install (no saved policy) starts on the Full preset instead, see [Default full policy](adrs/2026-11-24-default-full-policy.md); picking Read-only in the Policy tab switches back. Once the policy is migrated or saved from the Policy tab it is stamped with the current version, so an action you uncheck later is not granted again.

A denial names the action, the rule or the default policy, and where to enable it (the Policy tab). For `create_branch` and `write_file` it also notes that plain git commands are not affected by the policy.

## Calls from the client API

`/v1/rest` and `/v1/graphql` calls from the `gh` shim are classified like `github_api` calls (see above) and checked against the same owner allowlist and rules. `POST /v1/git-credential` needs `read` on the repository, and gets a write-capable token only where `write_file` and `create_branch` are both allowed; `force_push` and `delete_branch` cannot be told apart by a git credential, so a write token can do both (use branch protection). See [client-api.md](client-api.md).

## Paths without an owner

Your account, gists and notifications name no owner, so a call to them is denied unless `*` is an allowed owner (the default): `github_account` my_orgs and notifications without a `repo`, `github_gists` apart from `list` for a user, and `github_repo_manage` create without `owner`. Secrets are never returned: `github_repo_config` secrets lists names and dates, and no tool sets a secret value.

## Rule patterns

`owner/repo` with `*` matching any run of characters inside one part, case-insensitive: `acme/*`, `*/docs`, `acme/web-*`, `*`.

## Files

`$PASEO_HOME/plugin-data/lerenn/paseo-github-proxy/`: `config.json` (settings, policy), `apps.json` (GitHub Apps: organization, ids, extra owners, default flag; no secret), `secrets.json` (App private keys, webhook secrets and the client API token, 0600), `cache.json` (response cache).
