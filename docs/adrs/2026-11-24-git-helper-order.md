# Plugin git helper first, existing helpers as fallbacks

**Status:** Accepted. Supersedes the ordering detail of [git injection does not reset credential helpers](2026-11-24-git-injection-no-reset.md) (the plugin helper is appended after the existing ones); the rest of that ADR (helper never blocks git, injection only with a GitHub App) stands.

## Context

With the helper appended last, any helper git already had won. Images ship such helpers: on the lab daemon (a Kubernetes pod) `/etc/gitconfig` has `!gh git-credential` and `~/.gitconfig` the old gh shim, which asks `/v1/git/token` for a read token. `git fetch` worked, `git push` failed with 403 (read-only token), and the plugin helper, which would have decided write from the policy, was never asked. Image-level helpers can hand out read-only tokens and shadow the policy-gated helper. The earlier reset-first design was right about order but dropped the user's own helpers on a workstation with no App.

## Decision

- When a GitHub App is configured (the only time git config is injected), the session gets `credential.https://github.com.helper=` (reset), the plugin helper, then the github.com helpers git already has, then `useHttpPath=true`.
- The existing helpers are read at session open with `git config --get-all credential.https://github.com.helper` (no shell, 3 s timeout, cached 60 s). A failure means no fallbacks. Empty values, duplicates and the plugin helper itself are skipped; order is kept. The session's own `GIT_CONFIG_*` helper entries are kept as fallbacks too, and an existing `GIT_CONFIG_COUNT` is continued.
- Without an App nothing is injected, as before.
- The plugin helper still prints nothing and exits 0 when it cannot issue a token, so git then tries the fallbacks.

## Consequences

- The policy decides read or write for git wherever an App serves the owner, whatever the image configures.
- The plugin is asked first for every github.com repository, so a token is minted even where the machine's own credentials would work (cached by the plugin).
- The user's own helpers keep working as fallbacks.
