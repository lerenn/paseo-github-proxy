# Subscription model

Agents wait for GitHub state without polling it themselves. An agent calls an MCP tool to subscribe
and ends its turn. The daemon sends it a prompt, through the Paseo SDK, when the condition is met
or the timeout expires.

## Tools

| Tool | Purpose |
| --- | --- |
| `github_subscribe` | `repo?`, `number`, `events[]`, `timeout_seconds` (min 30), `ignore_authors?`. Returns the subscription, or an immediate answer when the condition already holds. |
| `github_unsubscribe` | Cancel one of the caller's active subscriptions. |
| `github_subscriptions` | The caller's subscriptions, active and recently finished. |

The agent id comes from the calling MCP session (bound when the agent's session opens), never from
the arguments, so an agent cannot subscribe or cancel on behalf of another.

## Events

| Event | Fires when |
| --- | --- |
| `checks_completed` | The head commit's check runs and statuses are all finished (at least one reported, none pending) and stay so for 20 s. A push after subscribing restarts the wait for the new head. |
| `review_submitted` | A review that was not there at subscribe time is submitted (not `PENDING`). |
| `pr_merged` | The pull request is merged. |
| `pr_closed` | The pull request is closed without merging. |
| `comment_created` | A new conversation comment or review comment appears. `ignore_authors` skips logins, for example the agent's own. |

A subscription may list several events and fires on the first moment any of them holds, reporting
everything that matched. It fires once and ends. Cancel, fire and timeout are mutually exclusive.

If the condition already holds when the agent subscribes (checks already finished on the current
head, already merged, already closed) the tool answers immediately instead of waiting for a change
that will not come.

## One source of truth

At subscribe time the plugin stores a **baseline**: head SHA, whether checks were settled, and the
ids of reviews and comments already present. A subscription fires when GitHub's current state shows
something beyond its baseline. Everything that detects events goes through this one function:

1. **Webhook forwarder (low latency).** A delivery is only a hint: "something happened on PR N (or
   commit S)". The plugin reads the pull request now, with conditional requests, and diffs it.
2. **ETag polling (safety net).** Every watched pull request is read on an interval, through the
   same cache and the same shared rate-limit budget as every other call. A `304` costs no budget.

Because both paths diff the same way, they cannot disagree, a duplicate delivery is harmless, and a
missed webhook is caught by the next poll. The city measured about 0.7% missed events, which is
why polling stays on even when the websocket is healthy.

Polling is never faster than 60 s (setting `pollSeconds`, minimum 60). While the repository's
forwarder is connected it slows to `pollSecondsWithWebhook` (default 300 s). Polling requests use the
`background` priority, so they yield to interactive calls when the budget is low, and a rate limit
only delays them; the deadline still bounds the wait.

### Webhook forwarder

The same mechanism as `gh webhook forward` (the `cli/gh-webhook` extension): create a hook named
`cli` with `active: false` on the repository, dial the returned `ws_url` with the token as the raw
`Authorization` header, activate the hook, then answer every delivery with `{Status, Header, Body}`.
Events requested: `check_run`, `check_suite`, `status`, `pull_request`, `pull_request_review`,
`pull_request_review_comment`, `issue_comment`, `workflow_run`.

- One forwarder per repository, shared by all subscriptions on it, opened when the first
  subscription starts and removed (hook deleted) when the last one ends.
- It needs admin rights on the repository. On 403/404, or 422 when another forwarder already
  exists for the repository, the repository is marked `unavailable` with the reason, left to polling,
  and tried again after 30 minutes.
- If the socket drops, the plugin reconnects with a fresh hook and exponential backoff (5 s up to
  5 min). While it is down the repository counts as not healthy and polling returns to the fast
  interval.
- `webhooks: off` in the settings disables forwarders entirely.

## Timeouts

Every subscription has a deadline (`timeout_seconds`, capped by `maxTimeoutMinutes`, default 240).
At the deadline the plugin reads the pull request one last time. If an event happened that no
source had delivered yet, the agent gets that event, not a timeout. Otherwise it gets a timeout
notice with the current state (open/merged/closed, head, checks) and a reminder that a timeout means
"nothing seen", not "nothing happened".

## Wake-up prompt

Sent with `agents.ref(agentId).send(text, { activeTurnBehavior: "steer" })`, so a busy agent is
steered instead of interrupted. The prompt names the subscription, the event and the relevant facts
(check names and results, reviewer and state, comment author and path). GitHub text from other
people (review and comment bodies) is quoted, cut to 600 characters, and preceded by a note that it
is data, not instructions.

A wake-up that fails is retried twice; after that the outcome records "agent unreachable" and the
event is not re-sent.

## Persistence and failure behavior

- Subscriptions are stored in `~/.paseo/github-proxy/subscriptions.json` (mode 0600) and restored
  when the plugin starts. Deadlines are kept; one that passed while the daemon was down times out
  immediately, and the notice says the daemon was restarted.
- An archived agent's subscriptions are cancelled.
- The newest 20 finished subscriptions are kept for the screen; at most 100 can be active.
- The Paseo API reaches a plugin only through hook and RPC contexts. Wake-ups wait up to 30 s for
  the first one to be seen after a plugin reload, which any agent start, session open, or screen
  load provides.
