# Client API (gh shim and git credential helper)

An optional, local HTTP endpoint so tools that cannot use the `github_*` tools still go through the plugin: the `gh` shim that talks to a github-proxy (`GH_PROXY_URL`), and `git fetch` / `git push` over HTTPS. Off by default. Every REST and GraphQL call runs the same pipeline as the tools (`server/proxy.ts`): owner allowlist, policy, per-owner GitHub App routing, rate limits, ETag cache, activity log and event-driven invalidation. See [the ADR](adrs/2026-11-24-client-api.md) for why it is a separate listener.

## Turn it on

Auth tab, *Client API (gh and git)*: turn on **Serve the client API**. Defaults: port `8788`, bind `127.0.0.1`, token not set, **Set it up in every new agent session** on. The card shows whether it listens, the URL, counters and a warning if the bind is not a loopback address.

Safety rules the server enforces, not only the UI:

- It is a different HTTP server on a different port from the webhook listener. The webhook listener (bound to `0.0.0.0`, reachable through the tunnel) serves `POST /webhook` and `GET /healthz` only; the client API serves `/v1/*` and `GET /healthz` only. Never route the client API through the webhook tunnel.
- With **no token**, only loopback peers are answered, requests with an `Origin` header (browsers) or a `Host` that is a name other than `localhost` are refused (DNS rebinding), and a non-loopback bind **refuses to start**.
- With a **token** (generate one in the card; shown once; stored in `secrets.json`, mode 0600; never logged, never returned by an RPC), every `/v1/*` call must send `Authorization: Bearer <token>` (constant-time compare). `GET /healthz` stays open and says only `{"status":"ok"}`.

## Routes

| Route | Meaning |
| --- | --- |
| `GET`, `POST`, `PATCH`, `PUT`, `DELETE /v1/rest/{path...}` | A GitHub REST call. The query string, `Accept` and the JSON body are forwarded; `ETag`, `Link`, `Content-Type` come back, with `X-Proxy-Cache: miss\|cache_hit\|revalidated\|stale`. A matching `If-None-Match` on a GET answers `304`. |
| `POST /v1/graphql` | `{query, variables}` plus the header `X-Proxy-Repo: owner/name` (scopes the call for the owner allowlist and policy). |
| `GET /v1/auth/status` | `{name}`: lets `gh auth status` check the credential. |
| `POST /v1/git-credential` | `{protocol, host, path}` as git sends them; answers `{username, password, expires_at, repository, access}`. Used by the helper below. |
| `POST /v1/git/token` | The old proxy's `{repository, access}` request, kept for `gh git-credential`. Answers `{token, password, username, expires_at, repository, access}`. |
| `GET /v1/watch/...` | `501 unsupported` (the shim falls back to its polling interval). |
| `GET /healthz` | `{"status":"ok"}`, no token needed. |

Errors are JSON. A denial is `403 {"error":"policy_denied","message":"...","rule":"rule #2" or "default policy","action":"merge"}`: the message names the rule or default policy, the action and where to enable it, and says not to retry. A GitHub error is passed through with its own status and body. `429 rate_limited` carries the retry time, `503 upstream_auth` means no App or credential could serve the owner.

## Git credentials

`POST /v1/git-credential` answers only `https://github.com/<owner>/<repo>[.git]` (git must send the path: `credential.useHttpPath=true`). Anything else gets `404 not_served`, which makes the helper print nothing so git tries the next helper.

1. The owner allowlist and the policy's `read` action must allow the repository, otherwise `403 policy_denied` (nothing is minted).
2. The token comes from the **GitHub App serving that owner** (the gh CLI cannot mint scoped tokens). It is created with `repositories: [repo]` and `permissions`.
3. **Read vs write.** The credential helper protocol cannot tell a fetch from a push, so write capability is granted by the policy for that repository: when the policy allows both `write_file` and `create_branch`, the token has `contents: write`; otherwise it is read-only (`contents: read`). `metadata: read` is always added. Honest limits: a write token can also force-push and delete branches (a token cannot be narrowed to ref operations), and cannot push `.github/workflows/*` (no `workflows` permission is requested). Keep branch protection on important branches. Under the PR workflow preset (no `write_file`) the token is read-only, so `git push` fails at GitHub with 403; use `github_create_pr` and the contents tools there.
4. `POST /v1/git/token` with `access: "read"` always gets the read token; `access: "write"` is refused (`403 policy_denied`) unless the policy allows write as above.
5. Tokens are cached per (App, repository, access) until five minutes before they expire, and concurrent requests share one mint. They are never logged; the activity log records the repository, the action (`read`, or `read+write_file+create_branch`) and `git read token` / `git write token`, nothing secret.
6. If GitHub refuses (HTTP 422), the App lacks the requested permission: grant *Contents* (read, or read and write) to the App and accept it on the installation.

## The helper and the session environment

`server/git-credential-helper.mjs` is a dependency-free Node script (`#!/usr/bin/env node`). The daemon bundles the server entry, so the plugin does not depend on where it is installed: the script is embedded in the server code (`server/helper-source.ts`, generated by `node .github/scripts/embed-helper.mjs`; a test fails if it drifts) and, while the client API and the session setup are on, written to the plugin data directory as `git-credential-helper.mjs` (mode 0700, next to `config.json`; rewritten atomically when its content differs). If the write fails (for example a read-only data directory) the Client API card in Auth shows the reason and sessions get only `GH_PROXY_URL` and `GH_PROXY_TOKEN`. It implements git's credential protocol: `get` reads `protocol`, `host`, `path` from stdin, calls `POST $GH_PROXY_URL/v1/git-credential` (with `Authorization: Bearer $GH_PROXY_TOKEN` when set) and prints `username=x-access-token` and `password=...`; `store` and `erase` do nothing. When the plugin cannot give a token (no GitHub App serves the owner, the active source is the gh CLI, `503 upstream_auth`, a policy denial `403`, the API off, refusing connections or slower than 3 seconds) it prints nothing and exits 0, so git moves on to its next helper or its prompt. The reason goes to stderr only when `GH_PROXY_DEBUG` or `GIT_TERMINAL_PROMPT` is set; the token never does.

With **Set it up in every new agent session** on, the plugin adds this to the environment of every session opened afterwards (hook `agent.open.before`, which is `agent.session_open`; launch-only `env`):

| Variable | Value |
| --- | --- |
| `GH_PROXY_URL` | `http://127.0.0.1:<port>` (the bind address; `0.0.0.0` maps to `127.0.0.1`) |
| `GH_PROXY_TOKEN` | the token, or the placeholder `none` when no token is set (the old shim refuses an empty value; the server ignores it) |
| `GIT_CONFIG_COUNT` and `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` | appended after any entries already present (an existing `GIT_CONFIG_COUNT` is continued, not overwritten): `credential.https://github.com.helper=!'<node>' '<data dir>/git-credential-helper.mjs'` (`<node>` is the absolute path of the node binary running the daemon, so no PATH is assumed), `credential.https://github.com.useHttpPath=true` |

The helper list is **not reset**, so the helpers the machine already has (`gh auth setup-git`, a keychain, a store) stay and ours comes after them. The trade-off: on a machine with its own working git credentials, those win and the plugin policy does not gate git (it still gates `gh` and the tools); on a machine with no other helper, such as a lab pod, the plugin is used. The git part is added only when at least one GitHub App is configured, because only an App can issue a scoped token; with the gh CLI and no App, sessions get `GH_PROXY_URL` and `GH_PROXY_TOKEN` only, and the Client API card says so. It is re-evaluated each time a session opens.

`node` must be on the agent's `PATH`. Only sessions opened after you change the setting (or reload the plugin, or rotate the token) are affected. The soft and hard rules (forbid `gh` and `curl`) are about raw access and are independent of this path: calls here go through the policy and are the supported way to run `gh`.

## What the lab image and `tools/gh` need

- Base URL: `GH_PROXY_URL=http://127.0.0.1:8788` (no trailing slash needed, no path prefix). The agent must run on the daemon's machine or container, because the default bind is loopback. For agents elsewhere, bind another address and set a token (and keep it off public routes).
- `GH_PROXY_TOKEN`: the bearer token (any non-empty value when the plugin has none). `tools/gh` fails with "set GH_PROXY_URL and GH_PROXY_TOKEN" if it is empty, hence the `none` placeholder.
- Do not set `GH_PROXY_RELEASE_TOKEN`: the plugin has no roles, and a different token on release routes would get `401`. Releases and refs are governed by the `manage_release`, `create_branch` and `force_push` actions instead.
- Git: no image change when the injection is on. Otherwise set `credential.useHttpPath=true` and `credential.https://github.com.helper='!node /path/to/git-credential-helper.mjs'`. The Go `gh git-credential` also works (it calls `/v1/git/token`); `GH_PROXY_GIT_ACCESS` is only a ceiling there (`write` is still decided by the policy).

## What differs from the old github-proxy

| Old | Plugin |
| --- | --- |
| `GET /v1/repos/{owner}/{repo}/pulls/...`, `/bundle`, `/threads`, `/files`, `/commits/{sha}/check-runs` (dataset routes) | Not offered: `404 route_not_found`. `tools/gh` does not use them; use `/v1/rest`. |
| `GET /v1/watch/{path}` (SSE) | `501 unsupported`. Use `github_subscribe` or poll. |
| `/v1/rest` reads limited to `/repos/...`, `rate_limit`, `search/issues` | Any GitHub path the policy allows (`generic_api_read`), scoped by owner (`/repos`, `/orgs`, `/users`, searches with `repo:`/`org:`/`user:`). `/user` and `/rate_limit` work. |
| Query string dropped on writes | Kept. |
| `X-GitHub-Api-Version` forwarded | Fixed to `2022-11-28`. Other `Accept` values (diff, raw) are forwarded. |
| Bearer tokens with roles (`reader`, `writer`, `releaser`) and per-token repo lists; `GH_PROXY_RELEASE_TOKEN` | One optional token; roles and repo scoping are the policy (rules per action and repo pattern), the same for every client. |
| Write rate limit per agent, `X-Proxy-Run` | One rate-limit tracker per credential (App or gh). `X-Proxy-Run` or `X-Paseo-Agent` only label the activity log. |
| Denial `error` codes `owner_not_allowed`, `policy_denied` (with `rule`, `reason`, `unmet`) | `policy_denied` for every denial (owner allowlist included), with `rule`, `action` and a message; no merge-gate `unmet` list. |
| Merge gates, workflow-file scan, GraphQL repo lists | Not present; the policy actions are the controls. |
| `POST /v1/git/token` write only for `GIT_WRITE_CLIENTS`; token `contents`, `pull_requests`, `workflows` write | Write decided by the policy (`write_file` and `create_branch`); token has `contents` write and `metadata` read only. |
| `/metrics`, NATS, Valkey | None. The Auth tab and Overview show state; the webhook receiver is a separate listener. |
| Read cache with its own datasets and refresh | The plugin's ETag cache with TTL, invalidated by verified webhook events. |
