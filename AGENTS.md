# Agent instructions

A Paseo plugin: policy-controlled GitHub tools for every agent. Read the `paseo-plugin` skill before changing plugin APIs. The plugin runs on desktop and mobile.

## Layout

- `paseo-plugin.json`, `index.server.ts`, `index.client.tsx`: manifest and the two entries. No other code in the root.
- `server/`: daemon side (Node). `classify.ts` (request → owners + actions), `policy.ts` (rules), `cache.ts` (ETag/TTL, disk), `ratelimit.ts`, `auth.ts` (gh CLI, GitHub App JWT), `proxy.ts` (the pipeline), `tools.ts` (agent tools), `store.ts` (config and secrets), `activity.ts`, `runtime.ts` (wiring).
- `client/`: app side, React Native primitives only (`node .github/scripts/mobile-audit.mjs` enforces it). `screen.tsx` is the page, one file per tab.
- `shared/`: Zod contracts (`contracts.ts`), config schema, action catalog. No Node, no React Native.
- `docs/adrs/`: decisions.
- `website/`: static GitHub Pages site (plain HTML and `style.css`, no build). Keep it in step with the README when tools, actions or settings change.

## Rules

- Every `server/` module that talks to GitHub, `gh` or the disk takes its dependencies (`fetch`, `exec`, clock, directory) as parameters, so tests mock them. Tests never use the network or real credentials.
- Secrets (the App private key) go only to `secrets.json` (mode 0600). Never log them, never put them in `config.json`, never return them over an RPC. The client sees `AppCredentialsView`.
- A denial message addresses the agent, names the rule or default policy, and says not to retry.
- Curated tools pass `actions` to `proxy.rest`; only `github_api` classifies a request from its path. A new tool declares its action explicitly.
- New policy actions go in `shared/actions.ts` (and the presets, `classify.ts`, README).
- Text uses theme colors (`theme.colors.*`), never fixed colors, except the brand tile.

## Checks before a pull request

```bash
npm run typecheck && npm test && node .github/scripts/mobile-audit.mjs
```

Shipped files (`client/`, `server/`, `shared/`, `assets/`, entries, manifest, `OVERVIEW.md`) changing requires a `package.json` version bump (CI checks it; merging to `main` tags a release).

## ADRs

A significant decision (architecture, how the plugin talks to Paseo, a new UI surface, packaging, a rule an earlier ADR set) gets `docs/adrs/YYYY-MM-DD-<slug>.md` in the same PR, with **Status**, **Context**, **Decision**, **Consequences**. Do not rewrite an accepted ADR: write a new one that supersedes it.

## Listing

`OVERVIEW.md` is the listing page: plain facts, no install commands, no em dashes. To publish a release to paseo.sh/plugins use the `update-official-plugin` skill.
