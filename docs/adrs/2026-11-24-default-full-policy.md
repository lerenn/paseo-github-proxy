# Default to the Full policy on a fresh install

## Status

Accepted. Supersedes the read-only default decided in [In-plugin GitHub proxy](2026-11-24-in-plugin-proxy.md) (point 5) and restated in [Default the owner allowlist to every owner](2026-11-24-default-allow-all-owners.md). The check order and the presets are unchanged.

## Context

The policy started on Read-only, so every write an agent attempted was denied until the user opened the Policy tab. The plugin is used in a trusted personal setup, where that friction was constant and the user always ended up on Full anyway.

## Decision

A fresh install (no saved policy) starts on the Full preset: every action of the catalog is allowed, including `generic_api_read` and `generic_api_write` (a test asserts Full equals the whole catalog). Allowed owners stay `*`, dry-run is unchanged.

Read-only and PR workflow stay available in the Policy tab, one tap each. Allow and deny rules (the soft rules) and the hard rule on raw `gh`, `curl` and `wget` still work and still apply on top of Full. Picking a preset stamps the current catalog version on the policy.

Saved policies are not touched: `config.json` keeps whatever policy it has, and the implied-action migration of [policy-action-migration](2026-11-24-policy-action-migration.md) is unchanged. A corrupt config file that is reset also gets the new default.

## Consequences

- Agents can merge, delete branches, force push, write files and call write endpoints on any allowed owner immediately after install. Anyone sharing the plugin with less trusted agents should pick Read-only or PR workflow first.
- To switch back: Policy tab, Preset, **Read-only**. Existing users see no change.
