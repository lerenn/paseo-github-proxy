# Webhooks, event-driven cache and agent wake-ups

**Status:** Accepted

## Context

Reads are fresh only by TTL (30 seconds) and ETag revalidation, and an agent that waits for CI or a review has to poll. GitHub can push events, which would fix both, but pushing needs an HTTP endpoint the plugin does not have, reachable from the internet, and anything that listens on a port is a new attack surface. Paseo plugins have no inbound HTTP and no secret vault; the plugin server is a Node process, so it can open a listener. The user dropped any message bus: the listener and the plugin stay in one process.

## Decision

1. **Opt-in listener.** `config.webhooks` is `{ enabled: false, port: 8787, bind: "127.0.0.1" }`. Only when enabled, `server/webhook.ts` starts a Node `http` server answering `POST /webhook` and `GET /healthz`; anything else is 404 or 405. Bodies over 1 MiB are refused (413) and the request is destroyed; header and request timeouts are 10 seconds. The plugin does not create a tunnel: GitHub needs a public URL, so the user puts a tunnel or reverse proxy in front, and the docs say so.
2. **Verification.** Each GitHub App has its own webhook secret, stored only in `secrets.json` (0600) beside its private key; the client sees `webhookSecretSet`. A secret is generated on the server (`github-proxy.webhook.secret`) and returned once. A delivery's `X-Hub-Signature-256` is checked with a constant-time compare against every App's secret (all are tried, so timing does not reveal which matched); the App that matches signed it. The event's owner must resolve (`resolveApp`) to that same App, else 403 with no detail. With no secret configured nothing is accepted. A repeated `X-GitHub-Delivery` is dropped after verification, so an unsigned request cannot poison the dedupe table. Ping and unused events answer 200 and do nothing. Nothing from a payload, signature or secret is logged.
3. **Event-driven cache.** An accepted event invalidates cached reads (`ResponseCache.invalidateWhere`): the paths the event class makes stale under `/repos/{repo}`, the repository page itself, and all GraphQL and search answers (their keys carry no repository). A push drops the repository. Invalidation, not patching: it is simple and cannot serve a wrong patched value. ETag revalidation and the TTL are unchanged and remain the fallback, and the only path when the listener is off.
4. **Wake-ups.** A curated tool `github_subscribe` (subscribe, list, unsubscribe) stores subscriptions in `subscriptions.json` (not secret), tied to the calling agent id, filtered by repo, a PR number and/or sha (either matches), event kinds and optional conclusion. One-shot by default, persistent optionally, default expiry 6 hours, maximum 7 days, 20 per agent. A match sends the agent a short prompt with `paseo.agents.ref(id).send(text, { activeTurnBehavior: "steer" })`, so a running turn is steered, not interrupted. The prompt holds the event kind, repository, PR number, conclusion, and a title cut to 100 characters on one line and quoted as GitHub text; it tells the agent to read details with the `github_*` tools. Wake-ups are limited to 6 per agent per minute (a limited subscription is kept); an error saying the agent is archived or missing drops its subscriptions.
5. **Policy.** A new action `subscribe_events` (low risk) covers subscribing. It is in the PR workflow and Full presets and denied in Read-only: it changes nothing on GitHub, but it makes the plugin prompt an agent, which a read-only setup should opt into with a rule.
6. **The SDK handle.** The plugin server has no `paseo` outside a hook, tool or RPC context, so the runtime keeps the latest one it was given (session open hook, tool calls, screen RPCs) and uses it for wake-ups.

## Consequences

- A user who enables it gets fresh reads right after a change and agents stop polling, at the cost of running a public tunnel and one secret per App.
- Off by default, no behaviour change for anyone who does nothing.
- After a daemon restart, wake-ups wait until some hook, tool or screen request gives the plugin a handle; the subscription is kept meanwhile. Whether a handle captured in a hook context stays valid for later use is not verified against a live daemon.
- A race (a read in flight while an event lands) can store an old answer until the next event or TTL.
- One `checks_completed` fires per finished check suite, not once per commit; agents should filter by conclusion or re-read the checks.
