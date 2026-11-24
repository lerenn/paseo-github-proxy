# Paseo GitHub Proxy

A [Paseo](https://paseo.sh) plugin that gives every agent policy-controlled, cached and rate-limit-aware GitHub tools, instead of each agent running `gh` or `curl` on its own.

- **One front door.** The `github_*` tools are added to every agent automatically.
- **Read-only by default.** You enable writes, per action and per repository.
- **Fewer API calls.** A shared in-memory and on-disk cache with ETag revalidation, so many agents asking the same thing cost one request.
- **Rate limits handled.** Live remaining/limit per credential source, a "retry at HH:MM" error to the agent when exhausted, one limit per GitHub App, optional fallback to the other credential source.
- **Clear denials.** The agent is told which rule denied a call and why, so it stops retrying.
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

Each App has an **Organization or user** (the account it is installed on, for example `acme`: it is the App's name everywhere and is served by the App automatically), the three fields above, an optional **Also serves** dropdown for extra owners covered by the same installation, and a **Default App** switch. The default App is the catch-all for owners no App claims, and for calls that name no owner; turning it on for one App turns it off for the others. An owner belongs to one App only (matched case-insensitively), and saving an App that claims an owner another App serves is refused with the owner and the App named. **Test connection** asks GitHub for an installation token for that App. Each App keeps its own installation token, its own rate limit (shown per App in Overview) and its own cache entries; the Activity tab shows which App served each call.

Pick **one active source**: the `gh` CLI, or the GitHub Apps (each call then uses the App of its owner). Optionally turn on **Fall back to the other source on rate limit**. If an owner has no App (and there is no default App), the agent is told that no App serves that owner and not to retry, unless the fallback lets `gh` answer.

Upgrading: a single App saved by an earlier version becomes one **default** App labelled "GitHub App" on first start, with its key moved to the new secrets layout; nothing needs to be re-entered. Apps saved with a label: if the label is a valid GitHub account name and the App claimed no owner, it becomes the organization; otherwise the label stays as a display name and the owners stay as they were (set the organization when you want it claimed).

### 2. Allow owners (Auth tab)

Open the **Allowed owners** dropdown and check the GitHub users and organizations agents may act on. The list comes from the active source (the gh user and their organizations, or the accounts the Apps are installed on, each App asked in turn); type a name to add one that is not listed. Checking **All owners (`*`)** clears the others. This is a safety net on top of the policy. The default is `*`, which allows every owner; replace it with specific owners to restrict agents. **If you clear the list, every call is refused.**

### 3. Set the policy (Policy tab)

Presets:

| Preset | Allows |
| --- | --- |
| **Read-only** (default) | read, generic API read |
| **PR workflow** | the above + comment, review, create issue, create PR, update PR |
| **Full** | everything |

Then adjust the default permissions in one checklist dropdown (checked means allowed), and add rules. A rule has an effect (allow or deny), repositories, actions (both checkable dropdowns) and an optional reason shown to the agent. The repository dropdown lists the repositories of the allowed owners that the policy lets agents read (first 100 per owner, cached; if listing fails you still can type); type a pattern such as `acme/*` or `acme/web-*` for the rest. A matching **deny** rule always wins, then an **allow** rule, then the defaults.

Examples:

- Read-only everywhere, but agents may comment and open PRs in your sandbox repos: preset *Read-only* + allow rule `lerenn/sandbox-*` for `comment, create_pr`.
- PR workflow everywhere, never merge or delete branches in prod: preset *PR workflow* + deny rule `acme/prod` for `merge, delete_branch, force_push`, reason "humans merge prod".
- Everything allowed except force pushes: preset *Full* + deny rule `*` for `force_push`.

Actions: `read`, `comment`, `review`, `create_issue`, `create_pr`, `update_pr`, `merge`, `delete_branch`, `force_push`, `generic_api_read`, `generic_api_write`. The generic `github_api` tool is classified from the request: a `PUT .../pulls/N/merge` needs `merge` **and** `generic_api_write`, so the generic tool never bypasses a rule on a specific action. The **Test this call** box shows the verdict for any REST path or GraphQL document without sending it.

The same tab holds the **cache TTL** (30 s by default) and the **Forbid direct use of gh/curl/raw GitHub** checkbox, which adds an instruction to every agent's system prompt and tool descriptions to use the `github_*` tools. It is a soft rule, not a sandbox. The instruction says the `github_*` tools win over a project AGENTS.md that allows `gh`, unless you explicitly ask for `gh`. On Paseo 0.16 it is saved in the system prompt when an agent is created, so only agents created after you turn it on get it; from 0.17 it is also added each time a session opens.

The **Block gh/curl commands (hard)** checkbox (off by default) goes further than the soft rule: when an agent asks permission to run a shell command that runs `gh`, or `curl` or `wget` against github.com, api.github.com or githubusercontent.com, the plugin denies the request with a message that points to the `github_*` tools and says not to retry. It matches command words after pipes, `&&`, `;`, subshells, env prefixes, `sudo` and `bash -c`, so `git` and `grep gh` pass. Denials appear in the Activity tab as `hard rule`. Its limits: it only sees commands the agent raises a permission request for, so an agent in a bypass or auto-approve mode never triggers it; it is pattern matching, not a sandbox, so a script file or a command built at run time gets through. For a real block, add network or egress rules on the daemon machine.

## Tools

| Tool | Action |
| --- | --- |
| `github_policy` | Shows what the agent may do on a repo, and the rate-limit state |
| `github_repo_info` | read |
| `github_list_branches` | read |
| `github_delete_branch` | delete_branch |
| `github_list_prs`, `github_get_pr` (files, reviews, comments) | read |
| `github_create_pr` | create_pr |
| `github_update_pr` | update_pr |
| `github_merge_pr` | merge |
| `github_comment` | comment |
| `github_review_pr` | review |
| `github_list_issues`, `github_get_issue` | read |
| `github_create_issue` | create_issue |
| `github_checks` (check runs + commit status, by ref or PR) | read |
| `github_search` (issues, PRs, code, repos, commits; needs a `repo`, `org` or `user` scope) | read |
| `github_api` (REST or GraphQL) | generic_api_read / generic_api_write, plus the specific action it is classified as |

`repo` can be omitted: it is inferred from the agent's working directory (`origin` remote).

## How a call is handled

1. Owner allowlist, then policy (denials name the rule and reason).
2. Cache: fresh within the TTL → served locally. Otherwise a conditional request with `If-None-Match`; a `304` costs no rate limit and restarts the clock.
3. Auth source: the active one, then the other if fallback is on. With Apps, the App is chosen by the owner of the call (the App claiming it, else the default App); a call spanning owners of two Apps is refused. A credential that is rate limited is skipped until its reset.
4. Rate limit: `x-ratelimit-*` headers are tracked per credential (the `gh` CLI and each App) and resource (`core`, `graphql`, `search`). A primary limit, a `retry-after` or a secondary-limit response blocks that credential until the reset; the other Apps are not affected. With nothing left to try, a cached answer is served stale, or the agent receives `Retry at HH:MM`.
5. Writes invalidate the cached reads of that repository. Cached answers are keyed by credential (`gh` or the App), so an answer fetched with one identity is never served to another.

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
- Activity and counters are in memory (reset on plugin restart); config and cache persist.
