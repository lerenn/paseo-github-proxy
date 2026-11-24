# In-plugin GitHub proxy

## Status

Accepted

## Context

Agents each call `gh` or `curl`, so they share no cache, exhaust one token's rate limit together, and nothing limits what they may write. An internal Go service (github-proxy) solved this with a GitHub App, a cache, a policy and an owner allowlist, but it is a separate deployment with NATS and Valkey.

## Decision

1. The logic runs inside the plugin server in TypeScript; no external service, no NATS, no Valkey.
2. The `github_*` tools are added to every agent in the `agent.open.before` hook through `defineAgentTool` (Paseo exposes them to the agent as MCP tools). The hook also appends the soft-rule instruction to the system prompt when enabled, which needs `@getpaseo/plugin` 0.17.0 (`appendSystemPrompt`); the manifest requires Paseo `>=0.17.0`.
3. Cache: in memory plus `cache.json`, keyed by method, URL and body hash; short TTL (30 s default), then ETag revalidation. A write drops the repo's cached reads. When rate limited, a stale entry is preferred over an error.
4. Auth: two sources, the local `gh` CLI or a GitHub App (JWT, installation token), one active, optional fallback on rate limit. Paseo's plugin settings are plain JSON, not a vault, so the App key lives in `secrets.json` (0600) and the client only sees a fingerprint.
5. Policy: actions (`read`, `comment`, … `generic_api_write`), a default allow list from a preset (read-only by default), and per-repo allow/deny rules. Deny beats allow beats default. The generic `github_api` tool is classified from the request and needs `generic_api_*` plus any specific action it performs.
6. Owner allowlist is checked before the policy; empty refuses everything.
7. UI: one screen (sidebar entry and Command Center item) with Overview, Auth, Policy and Activity tabs, polling the daemon every two seconds.

## Consequences

- Two agents asking the same question cost one request; revalidation is free of rate limit when nothing changed.
- The soft rule cannot stop a shell; it is an instruction. Sessions opened before a change keep the old description and prompt.
- GraphQL cannot be fully scoped to an owner (node IDs); such queries are refused unless every owner is allowed.
- Activity and counters reset on plugin restart.
