# gh parity

What the `gh` CLI (2.x) does, and where each command stands in this proxy. The proxy is network only and policy gated, so anything that needs a local checkout, a terminal, a browser or a credential prompt is out of scope.

Statuses:

- **covered**: a curated tool existed before the parity work.
- **added**: a curated tool or operation added by the parity work (version 0.5.0).
- **github_api only**: no curated tool; `github_api` reaches it (REST or GraphQL) and is classified from the request (see [policy.md](policy.md)).
- **out of scope**: not offered, with the reason.

Tools with an `operation` input group related commands so the tool list stays short (see the ADR [gh parity](adrs/2026-11-24-gh-parity.md)). Every write names its policy action; `read` covers all the reads. Paths that name no owner (your account, gists, notifications) are only reachable while `*` is an allowed owner.

## gh pr

| gh command | proxy tool or action | status | reason |
| --- | --- | --- | --- |
| `pr list` | `github_list_prs` (`read`) | covered | |
| `pr view` | `github_get_pr` (`read`; include files, commits, reviews, comments, threads, diff) | covered, extended | |
| `pr diff` | `github_get_pr` include `diff`; `github_commits` compare with `diff` | added | |
| `pr create` | `github_create_pr` (`create_pr`) | covered | |
| `pr edit` (title, body, base) | `github_update_pr` (`update_pr`) | covered | |
| `pr edit` (labels, assignees, milestone) | `github_update_issue` (`update_pr`) | added | |
| `pr edit` (reviewers) | `github_pr_manage` request_reviewers, remove_reviewers (`update_pr`) | added | |
| `pr close`, `pr reopen` | `github_update_pr` state (`update_pr`) | covered | |
| `pr ready`, `pr ready --undo` | `github_pr_manage` ready, draft (`update_pr`) | added | REST has no endpoint; uses GraphQL |
| `pr merge` | `github_merge_pr` (`merge`) | covered | |
| `pr merge --auto`, `--disable-auto` | `github_pr_manage` auto_merge, disable_auto_merge (`merge`) | added | |
| `pr review` | `github_review_pr` (`review`) | covered | |
| `pr comment` | `github_comment` (`comment`) | covered | |
| `pr comment --edit-last`, `--delete-last` | `github_edit_comment` (`update_pr`) | added | the agent lists comments and picks the id |
| review thread reply, resolve, unresolve | `github_pr_manage` reply, resolve_thread, unresolve_thread (`comment`, `review`) | added | |
| `pr checks` | `github_checks` (`read`) | covered | `--watch` is interactive: poll instead |
| `pr update-branch` | `github_pr_manage` update_branch (`update_pr`) | added | |
| `pr lock`, `pr unlock` | `github_update_issue` lock (`update_pr`) | added | |
| `pr status` | `github_search` (`review-requested:`, `author:` with a scope), `github_account` notifications | added | no single cross-repository view |
| `pr revert` | `github_api` GraphQL `revertPullRequest` | github_api only | rare; needs `generic_api_write` |
| `pr checkout` | | out of scope | needs a local git checkout |

## gh issue

| gh command | proxy tool or action | status | reason |
| --- | --- | --- | --- |
| `issue list` | `github_list_issues` (`read`) | covered | |
| `issue view` | `github_get_issue` (`read`) | covered | |
| `issue create` | `github_create_issue` (`create_issue`) | covered | |
| `issue comment` | `github_comment` (`comment`) | covered | |
| `issue edit` | `github_update_issue` (`update_pr`) | added | |
| `issue close`, `issue reopen` | `github_update_issue` state, state_reason (`update_pr`) | added | |
| `issue lock`, `issue unlock` | `github_update_issue` lock (`update_pr`) | added | |
| `issue status` | `github_search`, `github_account` notifications | added | |
| `issue delete`, `issue transfer`, `issue pin`, `issue unpin` | `github_api` GraphQL | github_api only | destructive or rare |
| `issue develop` | `github_contents` create_branch (a plain branch) | added | linked branches need GraphQL `createLinkedBranch` via `github_api` |

## gh repo

| gh command | proxy tool or action | status | reason |
| --- | --- | --- | --- |
| `repo view` | `github_repo_info` (`read`; include readme, languages) | covered, extended | |
| `repo list` | `github_account` list_repos (`read`) | added | |
| `repo create` | `github_repo_manage` create (`create_repo`) | added | |
| `repo fork` | `github_repo_manage` fork (`create_repo`) | added | |
| `repo edit` (description, homepage, topics, default branch) | `github_repo_manage` edit (`edit_repo`) | added | |
| `repo edit` (visibility, features, merge settings) | `github_api` PATCH | github_api only | high impact; left to `generic_api_write` |
| `repo sync` | `github_repo_manage` sync_fork (`merge`) | added | |
| `repo rename`, `repo archive`, `repo unarchive`, `repo delete` | `github_api` | github_api only | destructive; ask the user |
| `repo clone`, `repo set-default` | | out of scope | local git checkout and local gh config |
| `repo deploy-key list` | `github_repo_config` deploy_keys (`read`; titles only) | added | |
| `repo deploy-key add`, `delete` | `github_api` | github_api only | credential material |
| `repo autolink`, `gitignore`, `license` | `github_api` | github_api only | rare; the template endpoints name no owner |
| branches (`git branch`) | `github_list_branches`, `github_contents` create_branch, `github_delete_branch` | covered, extended | |
| files (`git show`, `git ls-tree`) | `github_contents` read, tree (`read`) | added | |
| file commits (`git commit` through the API) | `github_contents` write, delete (`write_file`) | added | |
| `git log`, `git show`, `git diff a...b` | `github_commits` list, get, compare (`read`) | added | |

## gh release

| gh command | proxy tool or action | status | reason |
| --- | --- | --- | --- |
| `release list` | `github_releases` list (`read`) | added | |
| `release view` | `github_releases` get (`read`) | added | |
| `release create` | `github_releases` create (`manage_release`) | added | |
| `release edit` | `github_releases` edit (`manage_release`) | added | |
| `release delete` | `github_releases` delete (`manage_release`) | added | |
| `release delete-asset` | `github_releases` delete_asset (`manage_release`) | added | |
| `release upload`, `release download` | | out of scope | binary files; a local file system |
| `release verify`, `release verify-asset` | | out of scope | attestation checks of local artifacts |

## gh run, gh workflow

| gh command | proxy tool or action | status | reason |
| --- | --- | --- | --- |
| `run list` | `github_actions` list_runs (`read`) | added | |
| `run view` | `github_actions` get_run (jobs and steps) (`read`) | added | |
| `run view --log`, `--log-failed` | `github_actions` job_logs (`read`; the end of a job's log) | added | the whole-run zip is binary |
| `run rerun` | `github_actions` rerun (`manage_actions`; failed_only, job_id) | added | |
| `run cancel` | `github_actions` cancel (`manage_actions`) | added | |
| `run delete` | `github_actions` delete_run (`manage_actions`) | added | |
| `run download` | `github_actions` list_artifacts (names only) | out of scope | artifacts are binary zips |
| `run watch` | | out of scope | interactive: poll `get_run` |
| `workflow list` | `github_actions` list_workflows (`read`) | added | |
| `workflow view` | `github_actions` list_runs with `workflow` | added | the YAML is readable with `github_contents` |
| `workflow run` | `github_actions` dispatch (`manage_actions`) | added | |
| `workflow enable`, `workflow disable` | `github_actions` enable, disable (`manage_actions`) | added | |
| `cache list` | `github_actions` list_caches (`read`) | added | |
| `cache delete` | `github_actions` delete_cache (`manage_actions`) | added | |

## gh search

| gh command | proxy tool or action | status | reason |
| --- | --- | --- | --- |
| `search issues`, `prs`, `code`, `repos`, `commits` | `github_search` (`read`; sort, order) | covered, extended | a repo, org or user scope is required |

## gh label

| gh command | proxy tool or action | status | reason |
| --- | --- | --- | --- |
| `label list` | `github_labels` list (`read`) | added | |
| `label create` | `github_labels` create (`manage_labels`) | added | |
| `label edit` | `github_labels` edit (`manage_labels`) | added | |
| `label delete` | `github_labels` delete (`manage_labels`) | added | |
| `label clone` | `github_labels` list on one repo, create on another | added | no single command |

## gh gist

| gh command | proxy tool or action | status | reason |
| --- | --- | --- | --- |
| `gist list`, `gist view` | `github_gists` list, get (`read`) | added | needs `*` as an allowed owner, except `list` for a user |
| `gist create` | `github_gists` create (`manage_gists`) | added | |
| `gist edit`, `gist rename` | `github_gists` edit (`manage_gists`) | added | |
| `gist delete` | `github_gists` delete (`manage_gists`) | added | |
| `gist clone` | | out of scope | local git checkout |

## gh project

| gh command | proxy tool or action | status | reason |
| --- | --- | --- | --- |
| `project list`, `project view`, `project field-list` | `github_project` list, view (`read`) | added | GraphQL; the token needs the `project` scope |
| `project item-list` | `github_project` items (`read`) | added | |
| `project item-add` | `github_project` add_item (`manage_project`) | added | |
| `project item-edit` | `github_project` set_field (`manage_project`) | added | single select, text, number, date |
| `project create`, `edit`, `close`, `delete`, `copy`, `link`, `mark-template` | `github_api` GraphQL | github_api only | project administration |
| `project item-create`, `item-archive`, `item-delete`, `field-create`, `field-delete` | `github_api` GraphQL | github_api only | rare |

## gh secret, gh variable

| gh command | proxy tool or action | status | reason |
| --- | --- | --- | --- |
| `secret list` | `github_repo_config` secrets (`read`; names only) | added | repository, organization or environment |
| `secret set` | | out of scope | the value must be sealed with the repository public key, and an agent should not handle secret values |
| `secret delete` | `github_repo_config` delete_secret (`manage_variables`) | added | |
| `variable list`, `variable get` | `github_repo_config` variables (`read`) | added | variables are not secret |
| `variable set` | `github_repo_config` set_variable (`manage_variables`) | added | |
| `variable delete` | `github_repo_config` delete_variable (`manage_variables`) | added | |

## gh ruleset

| gh command | proxy tool or action | status | reason |
| --- | --- | --- | --- |
| `ruleset list` | `github_repo_config` rulesets (`read`) | added | |
| `ruleset view` | `github_repo_config` ruleset (`read`) | added | |
| `ruleset check` | `github_repo_config` branch_rules (`read`) | added | |
| branch protection | `github_repo_config` branch_protection (`read`) | added | |
| rulesets, protection: create, edit, delete | `github_api` | github_api only | they decide who can merge; ask the user |

## gh org, gh status, notifications

| gh command | proxy tool or action | status | reason |
| --- | --- | --- | --- |
| `org list` | `github_account` my_orgs (`read`) | added | needs `*` as an allowed owner |
| organization profile, members, teams | `github_account` org, org_members, org_teams (`read`) | added | |
| user profile, `auth status` (who am I) | `github_account` user, me (`read`) | added | |
| `status` | `github_account` notifications (`read`) | added | |
| (no `gh` equivalent) wake an agent on an event | `github_subscribe` (`subscribe_events`) | added | needs the webhook listener |
| `pr checks --watch`, `run watch` (a PR, a commit sha, main CI, a tag build) | `github_subscribe` checks_completed with `pr`, `sha`, `branch`, `tag`, `workflow`, `conclusion` | added | push model, not a poll; `ttl_hours` up to 168 |
| wait for a push, a release, a merged queue group, auto-merge, a comment mentioning a handle | `github_subscribe` push, release_published, merge_queue_destroyed, pr_auto_merge, comment_added with `mentions` | added | `merge_group` needs a merge queue |
| mark notifications read | `github_account` mark_read (`manage_notifications`) | added | |

## gh api and the rest

| gh command | proxy tool or action | status | reason |
| --- | --- | --- | --- |
| `api` (REST) | `github_api` kind rest | covered | |
| `api graphql` | `github_api` kind graphql | covered | |
| `ssh-key list`, `add`, `delete`; `gpg-key list`, `add`, `delete` | `github_api` | github_api only | account credentials, no owner; only with `*` as an allowed owner |
| `auth login`, `logout`, `refresh`, `setup-git`, `switch`, `token`, `status` | | out of scope | interactive login; credentials are configured in the Auth tab |
| `browse` | | out of scope | opens a local browser |
| `codespace` | | out of scope | needs ssh, port forwarding and a terminal |
| `extension`, `alias`, `config`, `completion`, `help`, `version`, `preview` | | out of scope | the local CLI itself |
| `attestation` | | out of scope | verifies local artifacts |
| `agent-task`, `copilot` | | out of scope | not a GitHub data API |

## Running the real `gh` (or the lab shim) against the plugin

The tools above are for agents that can call MCP tools. The optional [client API](client-api.md) serves the same pipeline to a `gh` shim that speaks the old github-proxy wire format (`GH_PROXY_URL`): `gh api`, `gh pr`, `gh issue`, `gh run`, `gh release` and the like then reach GitHub as REST and GraphQL calls checked by the policy, and `git fetch` / `git push` over HTTPS get a scoped App token from the credential helper. Commands that need a local checkout, a browser or a prompt stay out of scope there too; `gh pr checks --watch` polls (no SSE `/v1/watch`).

## Summary

- Every `gh` command group that is a network call is now reachable through a curated, policy gated tool: pr, issue, repo, release, run, workflow, cache, search, label, gist, project, secret, variable, ruleset, org, status and api.
- Left to `github_api` (classified, so it still needs `generic_api_write` and the specific action): deletion and renaming of repositories, visibility and feature settings, ruleset and branch protection writes, deploy keys, ssh and gpg keys, issue delete, transfer and pin, project administration.
- Out of scope: anything that needs a local checkout (`pr checkout`, `repo clone`, `gist clone`), a terminal or an interactive prompt (`auth`, `run watch`, `codespace`), a browser (`browse`), binary transfers (`release upload` and `download`, `run download`), sealing secret values (`secret set`), or the local CLI itself (`extension`, `alias`, `config`).
