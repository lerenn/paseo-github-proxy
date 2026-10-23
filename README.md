# paseo-github-proxy

A [Paseo](https://paseo.sh) plugin that puts every agent's GitHub access behind one daemon-side client.
Agents never hold a GitHub token. The daemon holds the tokens, makes every REST and GraphQL call,
caches with conditional requests, spends one shared rate-limit budget per token, applies a write
policy, and wakes agents when the PR they wait for changes.

It is a generic rebuild of the github-proxy service used in the Gas City.

## Status

| PR | Scope | State |
| --- | --- | --- |
| 1 | Skeleton, CI, docs | in progress |
| 2 | Token settings, REST/GraphQL client, cache, rate limiter, screen | planned |
| 3 | MCP tools, `gh` shim, lockout hook | planned |
| 4 | Write policy | planned |
| 5 | Subscriptions: websocket, polling, timeouts | planned |

## Design

- Tokens: one write-only token per GitHub owner or org, set in the plugin screen, stored on the
  daemon at mode 0600 and never read back.
- Agent access: injected MCP tools (Claude and Codex) and a `gh`-compatible shim for reads.
  Both are added at agent creation by a `before("agent.create")` hook.
- Lockout by default: new agents lose `GH_TOKEN`, `GITHUB_TOKEN` and any GitHub MCP server, and the
  real `gh` is denied. An agent opts out with `PASEO_GITHUB_PROXY=off` in its environment.
- Writes: comments, PR creation, labels and review requests are allowed; merges and admin calls are
  refused by default. Per-repo allow and deny lists. Refused writes never reach GitHub and are audited.
- Events: see [docs/subscriptions.md](docs/subscriptions.md).
- Out of scope: git clone and push. Agents keep using SSH.

## Development

```
npm ci
npm run typecheck
npm test
```

CI runs the same steps through Dagger (`dagger call all`).
