# Repository-level events, mention filters and longer waits for github_subscribe

**Status:** Accepted

## Context

The webhook ADR (2026-11-24-webhooks-and-wakeups) gave agents wake-ups for pull request events. A pipeline that waits on CI, a merge queue, a release or a review bot needs more than that: main CI has no pull request, a tag build has a ref and no branch, a merge queue group is not a `pull_request` event, a review bot is recognised by a mention in a comment, and a CI wait can outlast six hours. The old cluster proxy covered these with a message bus and a fixed set of enriched fields. This plugin stays in one process and keeps the same safety rules.

## Decision

1. **More event kinds.** `push` (branch or tag, not a deletion), `release_published`, `merge_queue_checks_requested` and `merge_queue_destroyed` (from `merge_group`; the conclusion is the reason: merged, invalidated, dequeued; the PR number is read from the `gh-readonly-queue/.../pr-N-...` branch), and `pr_auto_merge` (conclusion enabled or disabled). `checks_completed` keeps covering `check_run`, `check_suite`, `workflow_run` and `status`, now with or without a pull request.
2. **More filters, all matched on the webhook payload only.** `branch`, `tag` (exact, or a trailing `*` prefix), `workflow` (workflow, check run or status context name, case-insensitive) and `mentions` (a list of strings searched case-insensitively in a comment or review body). `repo`, kind, `conclusion`, `branch`, `tag`, `workflow` and `mentions` must all match; `pr` and `sha` stay an either-or, and `sha` applies to every check event. A `branch` filter never matches an event known to be a tag, and the reverse; a workflow run only names its ref, so there either filter matches by name. `mentions` is rejected for kinds that carry no text.
3. **Safety unchanged.** The matched text is kept lower-cased and capped in memory on the normalized event and is never put in a prompt. A prompt adds a quoted ref name (cut short, on one line); titles stay quoted and truncated.
4. **Expiry.** The default stays 6 hours. `ttl_hours` (fractions allowed) sets it up to 168 hours; `expires_in_minutes` still works and `ttl_hours` wins when both are given. `persistent` is unchanged.
5. **Webhook events to subscribe.** The accepted event names are one list (`WEBHOOK_EVENTS` in `shared/config.ts`), shown in the Auth tab and the docs: check_run, check_suite, issue_comment, merge_group, pull_request, pull_request_review, pull_request_review_comment, push, release, status, workflow_run. `issues` and `pull_request_review_thread` are read for the cache only. Other events are ignored.
6. **Cache.** `merge_group` and `release` invalidate the matching reads like the other events; a push still drops the whole repository.

## Consequences

- The cluster wait scripts' needs (CI by PR, by sha, main CI, tag builds, queue merged, approval, a mention) are covered by subscriptions; a script that needs a count or an AND across several PRs still has to hold several subscriptions or re-read with `github_*` tools.
- A merge queue group of several pull requests carries several `pr-N` branches; only the first number is read, so for those wait on the `branch` filter and re-read the PRs.
- Wake-ups still depend on the listener, a public URL and a Paseo handle (see the earlier ADR); a missed delivery is not replayed, so waits keep a fallback.
- Subscriptions saved by 0.7.0 load unchanged (the new fields default to empty).
