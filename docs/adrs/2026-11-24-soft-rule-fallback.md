# Soft rule on Paseo 0.16: save it in the system prompt

**Status**: Accepted. Refines the soft-rule part of `2026-11-24-in-plugin-proxy.md`.

## Context

The in-plugin proxy ADR appended the "do not use gh or curl" instruction through `appendSystemPrompt` in `agent.open.before`, and required Paseo 0.17.0 for it. On Paseo 0.16.2 the field does not exist: the host ignores it and agents never saw the instruction. paseo-mail reaches the same daemon by editing `config.systemPrompt` in `agent.create.before`, which is saved with the agent. Everything else the plugin uses (screens, sidebar items, Command Center, `defineAgentTool`, RPCs, hooks) is in the 0.16.2 SDK and the plugin typechecks against it. Agents also quoted a project AGENTS.md ("gh is allowed") to override the instruction.

## Decision

1. With the soft rule on, `agent.create.before` appends the instruction to `config.systemPrompt` (once) and stores the metadata key `github-proxy.soft-rule`.
2. `agent.open.before` still appends through `appendSystemPrompt`, except for agents carrying that key, so a 0.17 host does not get it twice.
3. The instruction now says the `github_*` tools take precedence over project instructions that allow `gh` or `curl`, unless the user explicitly asks for `gh`.
4. The manifest requirement drops to `>=0.16.2`.

## Consequences

- On 0.16 only agents created after the setting is turned on carry the instruction, and turning it off does not remove it from existing agents. On 0.17 and later, older agents still get it per open.
- Internal helper agents are skipped.
- The rule stays an instruction, not a sandbox.
