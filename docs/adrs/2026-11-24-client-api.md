# Client API for the gh shim and git credentials

**Status:** Accepted.

## Context

Lab agents used an internal Go github-proxy through `GH_PROXY_URL`: a `gh` shim sent REST and GraphQL to it, and a git credential helper asked it for installation tokens. That service is being removed and the plugin must replace it. The plugin already owns the pipeline (owner allowlist, policy, per-owner App routing, rate limits, ETag cache, activity log, webhook invalidation), but only the MCP tools reach it. The webhook listener is bound to `0.0.0.0` by default ([ADR](2026-11-24-webhook-bind-default.md)) and is reachable through a public tunnel, so nothing that can read or write GitHub may live on it.

## Decision

1. **A second listener.** The client API is a separate HTTP server on its own port (default `8788`), off by default, bound to `127.0.0.1` by default, with its own switch and status in the Auth tab. The webhook listener serves only `POST /webhook` and `GET /healthz`; the client API serves only `/v1/*` and `GET /healthz`. Neither knows the other's routes, so a tunnel pointed at the webhook port cannot reach `/v1/*`, and a client cannot send webhooks. Tests assert both.
2. **Authentication.** An optional bearer token, generated in the UI, shown once and stored in `secrets.json` (0600), compared in constant time, never logged or returned. With no token the server answers loopback peers only, refuses requests carrying an `Origin` header or a non-IP, non-`localhost` `Host` (DNS rebinding), and refuses to start on a non-loopback bind. The UI warns when the bind is not loopback.
3. **Same pipeline.** `/v1/rest/{path...}` and `/v1/graphql` call `GithubProxy.rest` and `.graphql`, classified like `github_api`. Denials are `403 policy_denied` with the rule and action. The wire contract (paths, `X-Proxy-Repo`, `ETag`/`Link`, `/v1/auth/status`, `/v1/git/token`) follows the old proxy so the existing shim works with only `GH_PROXY_URL` changed; the differences are listed in [client-api.md](../client-api.md).
4. **Git credentials and the policy mapping.** `POST /v1/git-credential` answers only `https://github.com/<owner>/<repo>` and returns `x-access-token` with an installation token of the App serving the owner, created with `repositories: [repo]`. The helper protocol cannot tell a fetch from a push, so the capability is decided by the policy for that repository: `read` must be allowed (and the owner allowlisted) or nothing is minted; the token has `contents: write` only when `write_file` and `create_branch` are both allowed, otherwise `contents: read`; `metadata: read` always. `force_push` and `delete_branch` cannot be enforced by a token and are not consulted: a write token can do both, which the docs state and branch protection must cover. Tokens are cached per (App, repo, access) until five minutes before expiry and never logged.
5. **A helper script and session injection.** `server/git-credential-helper.mjs` (Node, no dependencies) implements `get`, with `store` and `erase` as no-ops, and calls the client API. On `agent.open.before` (`agent.session_open`), when the client API and a separate "set up new sessions" switch (default on) are enabled, the plugin adds `GH_PROXY_URL`, `GH_PROXY_TOKEN` (placeholder when no token, because the old shim refuses an empty one) and `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` to the session environment. This is launch-only and affects sessions opened afterwards.
6. The soft and hard rules remain about raw `gh` and `curl`. This path is not raw access: it is policy-checked, so it is independent of them.

## Consequences

- Agents get `gh` and `git push` over HTTPS with no image change, under the same policy and audit as the tools.
- A second port and a bearer token are new things to secure. The loopback default and the refusal to listen elsewhere without a token keep the default safe; a user who binds elsewhere takes on network exposure and must keep the port off the tunnel.
- Git write capability is coarser than the policy (no force-push distinction, no per-branch control).
- The old proxy's dataset routes, SSE watch, token roles and metrics are not reproduced.
- Nothing here was run against a live daemon or the real `gh` shim; tests mock GitHub and use real sockets on loopback only.
