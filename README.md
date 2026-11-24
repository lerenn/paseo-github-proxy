# Paseo GitHub Proxy

A [Paseo](https://paseo.sh) plugin that gives every agent policy-controlled, cached and rate-limit-aware GitHub tools, instead of each agent running `gh` or `curl` on its own.

- **One front door.** The `github_*` tools are added to every agent automatically.
- **Read-only by default.** You enable writes, per action and per repository.
- **Fewer API calls.** A shared in-memory and on-disk cache with ETag revalidation, so many agents asking the same thing cost one request.
- **Rate limits handled.** Live remaining/limit per credential source, a "retry at HH:MM" error to the agent when exhausted, one limit per GitHub App, optional fallback to the other credential source.
- **Clear denials.** The agent is told which rule denied a call and why, so it stops retrying.
- **Parity with `gh`.** Pull requests, issues, commits, files, releases, workflow runs and logs, labels, gists, projects, secret names and variables, rulesets, organizations and notifications, each as a typed tool with its own policy action. [docs/gh-parity.md](docs/gh-parity.md) lists every `gh` command and what is left out and why.
- **Optional webhooks.** Off by default. With a webhook listener, GitHub pushes events to the plugin: cached reads are invalidated at once, and agents can ask to be woken when checks finish, a review or comment arrives, or a PR is merged (`github_subscribe`).
- **A full-screen page** (sidebar → GitHub Proxy) with Overview, Auth, Policy and Activity tabs.

The logic is a TypeScript port of an internal Go service (GitHub App JWT and installation tokens, REST/GraphQL access, ETag cache, rate-limit handling, policy and owner allowlist). It runs inside the plugin server: no external service.

## Install

Requires Paseo 0.16.2 or later.

```bash
paseo plugin install github:lerenn/paseo-github-proxy
```

Then open **GitHub Proxy** in the sidebar (or Command Center → "Open GitHub Proxy").

## Set up

### 1. Choose a credential source (Auth tab)

**Local `gh` CLI.** Run `gh auth login` on the machine where the Paseo daemon runs, then press **Check gh** in the Auth tab. The plugin reads the token with `gh auth token` (cached for five minutes) and stores nothing.

**GitHub Apps.** A GitHub App is installed by one account, so one App cannot serve both an organization and a user: add one App per owner. Create each App with the permissions you need (for the PR workflow: Contents, Pull requests, Issues, Checks and Metadata read; write where you want writes), install it on your account or organization, then enter:

| Field | Where to find it |
| --- | --- |
| App ID | The App's settings page |
| Installation ID | The number at the end of the installation URL (`/settings/installations/<id>`) |
| Private key | Generate one on the App's settings page and paste the PEM |

The key is write-only: it is saved to `secrets.json` (mode `0600`) in the plugin's data directory (`$PASEO_HOME/plugin-data/lerenn/paseo-github-proxy`), never written to `config.json`, never logged, and never sent back to the app (the UI only sees a short fingerprint). Paseo has no secret vault for plugins, so this file is the protection: keep the daemon's home private.

Each App has an **Organization or user** (the account it is installed on, for example `acme`: it is the App's name everywhere and is served by the App automatically), the three fields above, an optional **Also serves** dropdown for extra owners covered by the same installation, and a **Default App** switch. The default App is the catch-all for owners no App claims, and for calls that name no owner; turning it on for one App turns it off for the others. An owner belongs to one App only (matched case-insensitively), and saving an App that claims an owner another App serves is refused with the owner and the App named. **Test connection** checks the App step by step, on the saved credentials or on what you typed in the form (nothing is saved, and the stored key is used unless you typed one): the key signs a JWT, GitHub knows the App ID, the installation id exists (with the account it is on and its permissions), a token is issued (with its expiry), the token works (with the remaining rate limit), and the Organization or user and extra owners match the installation. Each failure comes with a diagnosis; when the installation id is wrong, the App's real installations are listed and one tap fills the field. The token and key are never shown. Each App keeps its own installation token, its own rate limit (shown per App in Overview) and its own cache entries; the Activity tab shows which App served each call.

Pick **one active source**: the `gh` CLI, or the GitHub Apps (each call then uses the App of its owner). Optionally turn on **Fall back to the other source on rate limit**. If an owner has no App (and there is no default App), the agent is told that no App serves that owner and not to retry, unless the fallback lets `gh` answer.

Upgrading a policy: an action added after your policy was saved is allowed where an implying action is (`create_branch` where `create_pr` is, `manage_labels` where `update_pr` is, `subscribe_events` where `comment` is); destructive and admin actions are never implied. See `docs/policy.md`.

Upgrading: a single App saved by an earlier version becomes one **default** App labelled "GitHub App" on first start, with its key moved to the new secrets layout; nothing needs to be re-entered. Apps saved with a label: if the label is a valid GitHub account name and the App claimed no owner, it becomes the organization; otherwise the label stays as a display name and the owners stay as they were (set the organization when you want it claimed).

### 2. Allow owners (Auth tab)

Open the **Allowed owners** dropdown and check the GitHub users and organizations agents may act on. The list comes from the active source (the gh user and their organizations, or the accounts the Apps are installed on, each App asked in turn); type a name to add one that is not listed. Checking **All owners (`*`)** clears the others. This is a safety net on top of the policy. The default is `*`, which allows every owner; replace it with specific owners to restrict agents. **If you clear the list, every call is refused.**

### 3. Set the policy (Policy tab)

Presets:

| Preset | Allows |
| --- | --- |
| **Read-only** (default) | read, generic API read |
| **PR workflow** | the above + comment, review, create issue, create PR, update PR, create branch, manage labels, manage notifications |
| **Full** | everything |

Then adjust the default permissions in one checklist dropdown (checked means allowed), and add rules. A rule has an effect (allow or deny), repositories, actions (both checkable dropdowns) and an optional reason shown to the agent. The repository dropdown lists the repositories of the allowed owners that the policy lets agents read (first 100 per owner, cached; if listing fails you still can type); type a pattern such as `acme/*` or `acme/web-*` for the rest. A matching **deny** rule always wins, then an **allow** rule, then the defaults.

Examples:

- Read-only everywhere, but agents may comment and open PRs in your sandbox repos: preset *Read-only* + allow rule `lerenn/sandbox-*` for `comment, create_pr`.
- PR workflow everywhere, never merge or delete branches in prod: preset *PR workflow* + deny rule `acme/prod` for `merge, delete_branch, force_push`, reason "humans merge prod".
- Everything allowed except force pushes: preset *Full* + deny rule `*` for `force_push`.

Actions: `read`, `comment`, `review`, `create_issue`, `create_pr`, `update_pr`, `merge`, `delete_branch`, `force_push`, `create_branch`, `write_file`, `manage_labels`, `manage_release`, `manage_actions`, `manage_variables`, `create_repo`, `edit_repo`, `manage_gists`, `manage_notifications`, `manage_project`, `subscribe_events`, `generic_api_read`, `generic_api_write`. The reads of every tool are `read`; file writes, releases, workflow runs, variables, repository creation and edits, gists and projects are separate actions, none in the PR workflow preset. The generic `github_api` tool is classified from the request: a `PUT .../pulls/N/merge` needs `merge` **and** `generic_api_write`, so the generic tool never bypasses a rule on a specific action. The **Test this call** box shows the verdict for any REST path or GraphQL document without sending it.

The same tab holds the **cache TTL** (30 s by default) and the **Forbid direct use of gh/curl/raw GitHub** checkbox, which adds an instruction to every agent's system prompt and tool descriptions to use the `github_*` tools. It is a soft rule, not a sandbox. The instruction says the `github_*` tools win over a project AGENTS.md that allows `gh`, unless you explicitly ask for `gh`. On Paseo 0.16 it is saved in the system prompt when an agent is created, so only agents created after you turn it on get it; from 0.17 it is also added each time a session opens.

The **Block gh/curl commands (hard)** checkbox (off by default) goes further than the soft rule: when an agent asks permission to run a shell command that runs `gh`, or `curl` or `wget` against github.com, api.github.com or githubusercontent.com, the plugin denies the request with a message that points to the `github_*` tools and says not to retry. It matches command words after pipes, `&&`, `;`, subshells, env prefixes, `sudo` and `bash -c`, so `git` and `grep gh` pass. Denials appear in the Activity tab as `hard rule`. Its limits: it only sees commands the agent raises a permission request for, so an agent in a bypass or auto-approve mode never triggers it; it is pattern matching, not a sandbox, so a script file or a command built at run time gets through. For a real block, add network or egress rules on the daemon machine.

### 4. Webhooks and wake-ups (optional, Auth tab)

Off by default. With it off, nothing listens and reads stay fresh by TTL and ETag revalidation as before.

1. Open a saved GitHub App and press **Generate** under *Webhook secret*. The value is shown once; it is stored only in `secrets.json` (mode 0600) and the screen only ever learns "set" or "not set".
2. In the Auth tab turn on **Receive GitHub webhooks**, pick a port (default 8787) and a bind address (default `127.0.0.1`).
3. In the GitHub App's settings set the Webhook URL, the same secret, content type `application/json`, and subscribe to pull requests, reviews, comments, checks, statuses and workflow runs.

**GitHub needs a public URL.** The listener is at `http://<bind>:<port>/webhook` on the daemon machine; the plugin does not create a tunnel. Put a tunnel or reverse proxy in front of it (for example `cloudflared tunnel --url http://127.0.0.1:8787`) and give GitHub that public address ending in `/webhook`. `GET /healthz` answers `ok`.

What the listener accepts: only `POST /webhook` (bodies up to 1 MiB) with a valid `X-Hub-Signature-256` (HMAC-SHA256 over the raw body, constant-time compare). Every App's secret is tried; the App that matches signed it, and the event's owner must be one that App serves (its organization and extra owners, or the owners only the default App serves), otherwise `403` with no detail. `ping` and events the plugin does not use answer `200` and do nothing. A repeated `X-GitHub-Delivery` id is dropped. The Auth tab shows whether it listens, the last delivery time and counters (accepted, ignored, duplicates, bad signature, wrong owner). Secrets, payloads and signatures are never logged.

**Fresh cache.** An accepted event drops the cached reads it makes stale: pull request, issue, comment, review, commit, check and workflow reads of that repository, its repository page, GraphQL and search answers (a push drops the repository). It invalidates rather than patches. A read racing with an event can still store the old answer until the next event or the TTL; ETag revalidation remains the fallback.

**Wake-ups.** `github_subscribe` lets an agent say "wake me when X": `events` (`checks_completed`, `review_submitted`, `comment_added`, `pr_opened`, `pr_merged`, `pr_closed`), a `repo`, optionally a `pr` number and/or `sha` (an event for either matches), optionally `conclusion` (`success`, `failure`, `approved`, `changes_requested`, ...). One-shot by default, `persistent` keeps firing. It expires after 6 hours by default, at most 7 days; at most 20 per agent. Subscriptions are kept in `subscriptions.json`, tied to the agent, and listed (with Unsubscribe) in the Activity tab. When an event matches, the agent gets a short prompt through the Paseo SDK (`paseo.agents.ref(id).send(...)`, steering a running turn rather than interrupting it) with the event, repository, PR and a hint to read details with the `github_*` tools. The only GitHub text in it is a title, cut to 100 characters and quoted. Wake-ups are limited to 6 per agent per minute, and the subscriptions of an archived or missing agent are dropped. The `subscribe_events` action is in the PR workflow and Full presets and denied in the read-only default (it changes nothing on GitHub, but it makes the plugin prompt the agent; allow it with a rule if read-only agents need it). Note that a pull request has one `checks_completed` event per finished check suite, so use a `conclusion` filter or re-check with `github_checks` after the wake-up.

## Tools

Related operations are grouped behind one tool with an `operation` input (for example `github_actions` or `github_releases`), so an agent sees about thirty tools rather than a hundred. Each operation states its own action, so one tool can need `read` for one operation and `manage_actions` for another. `docs/gh-parity.md` maps every `gh` command to a tool.

| Tool | What it does | Action |
| --- | --- | --- |
| `github_policy` | What you may do on a repo (every action allowed or denied, with the reason) and the active rate-limit state. | — |
| `github_repo_info` | Description, default branch, visibility, topics, open issue count; include readme or languages. | `read` |
| `github_list_branches` | List branches. | `read` |
| `github_delete_branch` | Delete a branch. | `delete_branch` |
| `github_list_prs` | List pull requests. | `read` |
| `github_get_pr` | One pull request; include files, commits, reviews, comments, review threads or the raw diff. | `read` |
| `github_create_pr` | Open a pull request. | `create_pr` |
| `github_update_pr` | Edit, close or reopen a pull request. | `update_pr` |
| `github_pr_manage` | Ready or draft, update the branch, auto-merge, request reviewers, reply to a review comment, resolve or unresolve a thread. | update_pr, merge, comment or review, by operation |
| `github_merge_pr` | Merge a pull request; pass sha to refuse if the branch moved. | `merge` |
| `github_review_pr` | Approve, request changes or comment, with optional line comments. | `review` |
| `github_comment` | Comment on an issue or pull request. | `comment` |
| `github_edit_comment` | Edit or delete an issue, pull request or review comment. | `update_pr` |
| `github_list_issues` | List issues. | `read` |
| `github_get_issue` | One issue, optionally with comments. | `read` |
| `github_create_issue` | Open an issue. | `create_issue` |
| `github_update_issue` | Edit, close or reopen an issue or PR; set, add or remove labels and assignees; lock or unlock. | `update_pr` |
| `github_checks` | Check runs and commit status of a ref or pull request. | `read` |
| `github_commits` | List commits, get one (files or raw diff), compare two refs. | `read` |
| `github_contents` | Read a file or directory, list the tree; write or delete a file (a commit); create a branch. | read, write_file or create_branch, by operation |
| `github_search` | Search issues, PRs, code, repos or commits. Needs a repo, org or user scope. | `read` |
| `github_releases` | List, get, create, edit, delete releases; delete an asset. | read or manage_release, by operation |
| `github_actions` | Workflows, runs, jobs, the end of job logs, artifacts and caches; re-run, cancel, dispatch, enable, disable, delete. | read or manage_actions, by operation |
| `github_labels` | List, get, create, edit, delete repository labels. | read or manage_labels, by operation |
| `github_repo_manage` | Create or fork a repository, edit its description, homepage, topics or default branch, sync a fork. | create_repo, edit_repo or merge, by operation |
| `github_repo_config` | Rulesets, branch protection, environments, deploy keys, secret names, variables; set or delete variables, delete secrets. | read or manage_variables, by operation |
| `github_account` | Users, organizations, members, teams, repositories of an owner, your account and organizations, notifications, mark as read. | read or manage_notifications, by operation |
| `github_gists` | List, get, create, edit, delete gists. | read or manage_gists, by operation |
| `github_project` | List and view GitHub Projects (v2), list items; add an item, set a field. | read or manage_project, by operation |
| `github_subscribe` | Ask to be woken by a GitHub event instead of polling: subscribe, list, unsubscribe. Needs the webhook listener. | subscribe_events (subscribe only) |
| `github_api` | REST or GraphQL for what the others do not cover. | generic_api_read / generic_api_write + the specific action |

`repo` can be omitted: it is inferred from the agent's working directory (`origin` remote).

## How a call is handled

1. Owner allowlist, then policy (denials name the rule and reason).
2. Cache: fresh within the TTL → served locally. Otherwise a conditional request with `If-None-Match`; a `304` costs no rate limit and restarts the clock.
3. Auth source: the active one, then the other if fallback is on. With Apps, the App is chosen by the owner of the call (the App claiming it, else the default App); a call spanning owners of two Apps is refused. A credential that is rate limited is skipped until its reset.
4. Rate limit: `x-ratelimit-*` headers are tracked per credential (the `gh` CLI and each App) and resource (`core`, `graphql`, `search`). A primary limit, a `retry-after` or a secondary-limit response blocks that credential until the reset; the other Apps are not affected. With nothing left to try, a cached answer is served stale, or the agent receives `Retry at HH:MM`.
5. Writes invalidate the cached reads of that repository, and so does a verified webhook event for it (see Webhooks). Cached answers are keyed by credential (`gh` or the App), so an answer fetched with one identity is never served to another.

## Website

`website/` is a static site (home, getting started, how it works, reference) published to GitHub Pages by `.github/workflows/pages.yml` when `website/**` changes on `main`. It needs Pages enabled with source "GitHub Actions" in the repository settings. No custom domain is configured; the canonical URLs in the pages and sitemap use `https://lerenn.github.io/paseo-github-proxy/`.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run lint   # typecheck + mobile audit
```

Tests mock GitHub and `gh`; no network and no real credentials are used. See [AGENTS.md](AGENTS.md) and [docs/](docs/).

## Known limits

- Plugin tools reach agents through Paseo's agent-tool mechanism (`defineAgentTool`), which Paseo exposes to the agent as MCP tools.
- The soft rule cannot stop an agent that has a shell from running `gh`; it is an instruction.
- The hard rule only sees permission requests (nothing in bypass mode) and matches command text; it is not a sandbox. Block egress to GitHub on the daemon machine for a real block.
- GraphQL scoping is best effort: it checks the repo you pass and `owner:` literals in the query; node-ID queries are refused unless every owner is allowed.
- Webhooks need a public URL that you provide. Wake-ups need the plugin to hold a Paseo SDK handle: it takes one from the first session open or screen request after a daemon restart, so an event arriving before that is not delivered to the agent (its subscription is kept).
- Activity and counters are in memory (reset on plugin restart); config and cache persist.
