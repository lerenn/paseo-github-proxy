# paseo-github-proxy

A [Paseo](https://paseo.sh) plugin that puts every agent's GitHub access behind one daemon-side client.
Agents never hold a GitHub token. The daemon holds the tokens, makes every REST and GraphQL call,
caches with conditional requests, spends one shared rate-limit budget per token, applies a write
policy, and wakes agents when the PR they wait for changes.

It is a generic rebuild of the github-proxy service used in the Gas City.

## Status

| PR | Scope | State |
| --- | --- | --- |
| 1 | Skeleton, CI, docs | merged |
| 2 | Token settings, REST/GraphQL client, cache, rate limiter, screen | merged |
| 3 | MCP tools, `gh` shim, lockout hook | merged |
| 4 | Write policy | in review |
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

## How agents reach it

The plugin runs a local endpoint on `127.0.0.1:47821` (change with `GITHUB_PROXY_PORT` in the daemon's
environment; resumed agents keep the URL they were created with, so keep it stable). Each new agent
gets a capability token that only identifies it to that endpoint; it carries no GitHub access.

- `/mcp`: MCP over streamable HTTP, injected into the agent's config as server `github-proxy`.
  Read tools: `github_pr_view`, `github_pr_list`, `github_pr_checks`, `github_pr_diff`,
  `github_issue_view`, `github_comments`, `github_api` (GET), `github_graphql` (queries),
  `github_rate_limit`.
- `/gh`: backs a `gh` script placed first on the agent's `PATH`. Supported: `gh api` (GET and
  GraphQL queries, `--jq` through the system `jq`), `gh pr view|list|checks|diff`,
  `gh issue view|list`, `gh run list|view`, `gh repo view`. Writes are refused with a pointer to the
  MCP tools.
- Lockout: `GH_TOKEN`, `GITHUB_TOKEN` and the enterprise variants are set empty, `GH_CONFIG_DIR`
  points at an empty directory, and MCP servers that look like GitHub (by name, URL or command) are
  removed. `PASEO_GITHUB_PROXY=off` in the creation environment skips all of this.
- Linux and macOS only (the shim is a `#!/usr/bin/env node` script, so Node must be on `PATH`).

## Write policy

Every write goes through one gate: classify the call, check the policy, audit, then send. Write
tools: `github_comment`, `github_pr_create`, `github_label`, `github_request_review`,
`github_pr_merge`, and the generic `github_write` and `github_graphql` (mutations). They are not
pre-approved, so the agent's own permission mode still applies on top of the policy.

- Operations: `comment`, `comment.delete`, `pr.create`, `pr.update`, `pr.close`, `pr.merge`, `label`,
  `review.request`, `review.submit`, `issue.create`, `issue.update`, `branch.delete`, `admin`, `other`.
- Default allow: `comment`, `pr.create`, `label`, `review.request`. Everything else is refused,
  including anything the classifier does not recognize (`other`).
- Rules per repository (`owner/name`, `owner/*`, `*`; case-insensitive) add allows and deny
  operations. A deny from the defaults or any matching rule always wins. Example: allow `pr.merge`
  on `anyshift-io/*` and deny it on `anyshift-io/tf-aws`.
- A call may need several operations (closing a PR through the issues endpoint needs `issue.update`
  and `pr.close`); all must be allowed.
- GraphQL mutations address objects by id, so the repository is unknown. For them every repository
  deny applies and only `*` rules can allow, which means a "never merge in tf-aws" rule also blocks
  GraphQL merges everywhere unless merges are globally allowed and not denied by any rule.
- Refused writes are never sent. Both outcomes are appended to `~/.paseo/github-proxy/audit.jsonl`
  (mode 0600, one rotation at 5 MB) with agent, repo, operations, a short summary and the status.
  Request bodies are not logged. The screen shows the latest entries.
- The `gh` shim never writes.

## Development

```
npm ci
npm run typecheck
npm test
```

CI runs the same steps through Dagger (`dagger call all`).
