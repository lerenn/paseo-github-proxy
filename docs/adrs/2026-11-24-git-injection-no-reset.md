# Git injection does not reset credential helpers

**Status:** Accepted. Supersedes the helper-reset detail of [the client API ADR](2026-11-24-client-api.md).

## Context

The session setup added `GIT_CONFIG_*` entries starting with an empty `credential.https://github.com.helper`, which clears git's helper list, then the plugin helper. On a daemon whose source is the gh CLI with no GitHub App, the plugin cannot issue a token (`503 upstream_auth`), and the reset had removed the user's own helpers, so `git fetch` and `git push` over HTTPS failed with "could not read Username" in every new session.

## Decision

- No empty-value entry: the plugin helper is appended after the helpers git already has. Existing `GIT_CONFIG_COUNT` entries are continued, not overwritten.
- The helper never blocks git. When the plugin cannot give a token (no App, gh source, 503, policy 403, unreachable, slower than 3 s) it prints nothing and exits 0, so git tries the next helper or prompts. It writes the reason to stderr only when `GH_PROXY_DEBUG` or `GIT_TERMINAL_PROMPT` is set, never the token. This replaces the earlier `quit=1` on refusal.
- The git part of the injection is added only when a GitHub App is configured. Otherwise sessions get `GH_PROXY_URL` and `GH_PROXY_TOKEN` only, and the Client API card says git is left alone. It is re-evaluated each time a session opens.

## Consequences

- Existing credentials keep working. On a machine with its own working git credentials, those win and the plugin policy does not gate git; on a machine with no other helper the plugin is used.
- A policy denial no longer stops git with a message; git falls through to its next helper or prompt (the message is in debug output and the Activity tab).
- The policy gates `gh` and the tools in every case, git only where the plugin helper is the one answering.
