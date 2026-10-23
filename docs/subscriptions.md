# Subscription model

Agents wait for GitHub state without polling it themselves. An agent calls an MCP tool to subscribe;
the daemon wakes it by sending it a prompt through the Paseo SDK when the condition is met or the
timeout expires.

## Subscription

| Field | Meaning |
| --- | --- |
| `id` | Opaque id returned to the agent. Used to cancel. |
| `agentId` | The agent to wake. Taken from the calling MCP session, not from the request. |
| `repo`, `number` | Target repository and PR or issue number. |
| `events` | One or more of `checks_completed`, `review_submitted`, `pr_merged`, `pr_closed`, `comment_created`. |
| `timeoutSeconds` | Deadline. Required, with a plugin-wide maximum. |
| `createdAt`, `status` | `active`, `fired`, `timed_out`, `cancelled`. |

A subscription fires once, then ends. The agent resubscribes if it wants more. Firing and timing out
are the only terminal outcomes besides cancel; both are exclusive (compare-and-set on `status`).

## Wake-up prompt

On fire: the event type, repo, number, the relevant payload summary (check conclusions, reviewer and
state, comment author and a bounded body excerpt) and the subscription id. On timeout: a notice that
nothing happened within N seconds, plus the current state read through the cache so the agent can
decide without another call. Untrusted text (comment bodies) is quoted and length-limited.

## Sources

1. **Webhook forwarder (primary).** An outbound websocket to GitHub's webhook forwarding service, as
   used by `gh webhook forward`. It needs admin on the repository or organization, and GitHub allows
   one forwarder per repository, so the plugin keeps one connection per watched repository and shares
   it between all subscriptions. Events are matched against active subscriptions. The connection is
   re-established with backoff; while it is down the repository counts as degraded and polling
   tightens.
2. **ETag polling (safety net).** For each watched item the plugin makes conditional requests, at 60
   seconds or slower, through the same cached client and budget as every other call. A `304` costs
   no rate limit. Polling derives the same events by diffing against the last seen state (check
   run conclusions, review ids, comment ids, merged flag), so a missed webhook is caught on the next
   poll. The city measured about 0.7% missed events, which is why polling stays on even when the
   websocket is healthy, at a slower rate.
3. **Timeouts.** Every subscription has a deadline. A timer ends it with a timeout notice, so an agent
   is never left waiting on a lost event.

## De-duplication

Webhook and polling can both see the same change. Each subscription records the ids it has already
reported, and the first source to deliver wins; the other is a no-op.

## Failure behavior

- Daemon restart: subscriptions are persisted to disk and restored; their deadlines are kept.
- Agent gone or archived: the subscription is dropped.
- Rate limit exhausted: polling is deprioritized below interactive calls and pauses until the
  budget recovers; timeouts still fire.
