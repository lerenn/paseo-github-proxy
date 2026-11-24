# Paseo GitHub Proxy

A [Paseo](https://paseo.sh) plugin that gives every agent policy-controlled, cached and rate-limit-aware GitHub tools, instead of each agent running `gh` or `curl` on its own.

- **One front door.** The `github_*` tools are added to every agent automatically.
- **Read-only by default.** You enable writes, per action and per repository.
- **Fewer API calls.** A shared in-memory and on-disk cache with ETag revalidation, so many agents asking the same thing cost one request.
- **Rate limits handled.** Live remaining/limit per credential source, a "retry at HH:MM" error to the agent when exhausted, optional fallback to the other credential source.
- **Clear denials.** The agent is told which rule denied a call and why, so it stops retrying.
- **A full-screen page** (sidebar → GitHub Proxy) with Overview, Auth, Policy and Activity tabs.

The logic is a TypeScript port of an internal Go service (GitHub App JWT and installation tokens, REST/GraphQL access, ETag cache, rate-limit handling, policy and owner allowlist). It runs inside the plugin server: no external service.

## Install

Requires Paseo 0.17.0 or later.

```bash
paseo plugin install github:lerenn/paseo-github-proxy
```

Then open **GitHub Proxy** in the sidebar (or Command Center → "Open GitHub Proxy").

## Set up

### 1. Choose a credential source (Auth tab)

**Local `gh` CLI.** Run `gh auth login` on the machine where the Paseo daemon runs, then press **Check gh** in the Auth tab. The plugin reads the token with `gh auth token` (cached for five minutes) and stores nothing.

**GitHub App.** Create an App with the permissions you need (for the PR workflow: Contents, Pull requests, Issues, Checks and Metadata read; write where you want writes), install it on your account or organization, then enter:

| Field | Where to find it |
| --- | --- |
| App ID | The App's settings page |
| Installation ID | The number at the end of the installation URL (`/settings/installations/<id>`) |
| Private key | Generate one on the App's settings page and paste the PEM |

The key is write-only: it is saved to `secrets.json` (mode `0600`) in the plugin's data directory (`$PASEO_HOME/plugin-data/lerenn/paseo-github-proxy`), never written to `config.json`, never logged, and never sent back to the app (the UI only sees a short fingerprint). Paseo has no secret vault for plugins, so this file is the protection: keep the daemon's home private.

Pick **one active source**. Optionally turn on **Fall back to the other source on rate limit**.

### 2. Allow owners (Auth tab)

Add the GitHub users and organizations agents may act on, for example `acme, lerenn`. This is a safety net on top of the policy. `*` allows all owners. **While the list is empty every call is refused.**

### 3. Set the policy (Policy tab)

Presets:

| Preset | Allows |
| --- | --- |
| **Read-only** (default) | read, generic API read |
| **PR workflow** | the above + comment, review, create issue, create PR, update PR |
| **Full** | everything |

Then adjust the default permission per action, and add rules. A rule has an effect (allow or deny), repository patterns (`acme/*`, `acme/web-*`, `*`), a list of actions and an optional reason shown to the agent. A matching **deny** rule always wins, then an **allow** rule, then the defaults.

Examples:

- Read-only everywhere, but agents may comment and open PRs in your sandbox repos: preset *Read-only* + allow rule `lerenn/sandbox-*` for `comment, create_pr`.
- PR workflow everywhere, never merge or delete branches in prod: preset *PR workflow* + deny rule `acme/prod` for `merge, delete_branch, force_push`, reason "humans merge prod".
- Everything allowed except force pushes: preset *Full* + deny rule `*` for `force_push`.

Actions: `read`, `comment`, `review`, `create_issue`, `create_pr`, `update_pr`, `merge`, `delete_branch`, `force_push`, `generic_api_read`, `generic_api_write`. The generic `github_api` tool is classified from the request: a `PUT .../pulls/N/merge` needs `merge` **and** `generic_api_write`, so the generic tool never bypasses a rule on a specific action. The **Test this call** box shows the verdict for any REST path or GraphQL document without sending it.

The same tab holds the **cache TTL** (30 s by default) and the **Forbid direct use of gh/curl/raw GitHub** checkbox, which adds an instruction to every agent's system prompt and tool descriptions to use the `github_*` tools. It is a soft rule, not a sandbox.

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
3. Auth source: the active one, then the other if fallback is on. A source that is rate limited is skipped until its reset.
4. Rate limit: `x-ratelimit-*` headers are tracked per source and resource (`core`, `graphql`, `search`). A primary limit, a `retry-after` or a secondary-limit response blocks the source until the reset. With nothing left to try, a cached answer is served stale, or the agent receives `Retry at HH:MM`.
5. Writes invalidate the cached reads of that repository.

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
- GraphQL scoping is best effort: it checks the repo you pass and `owner:` literals in the query; node-ID queries are refused unless every owner is allowed.
- Activity and counters are in memory (reset on plugin restart); config and cache persist.
