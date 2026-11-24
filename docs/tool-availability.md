# Tool availability in open sessions

Verified in this plugin's code (`index.server.ts`, `server/tools.ts`):

- Every `github_*` tool is built by `buildTools` inside the `agent.open.before` hook, synchronously and unconditionally. Nothing depends on a setting except the description suffix (the soft rule), so the set of names is the same for every session and every open (covered by a test in `server/tools.test.ts`).
- The tools are launch-only: they belong to the session that was opened with them. They are not registered once at plugin start.

What the host does (Paseo plugin reference): starting, stopping or reloading a plugin with a session-open hook marks open agent sessions stale, and each reopens before its next idle prompt. So after a plugin update or reload (this plugin is redeployed often), an open session can briefly run with the old tool registration, or none, until it reopens.

Known limits, host behaviour not fixable here:

- A "Tool github_... not found" right after a plugin reload comes from a session that has not reopened yet. Sending the next prompt reopens it.
- A deferred tool schema loaded earlier (ToolSearch) may not match the reopened session; load it again with a new ToolSearch.
- Background subagents run without an idle prompt in between, so they can hit the stale window until they reopen.

This was not reproduced against a live daemon; the host behaviour is taken from the plugin reference.
