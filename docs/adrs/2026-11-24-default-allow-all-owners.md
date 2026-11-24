# Default the owner allowlist to every owner

## Status

Accepted. Amends point 6 of [In-plugin GitHub proxy](2026-11-24-in-plugin-proxy.md) (default only; the check order is unchanged).

## Context

The allowlist defaulted to empty, so a fresh install refused every call until the user typed an owner. The policy (read-only by default) is already the main control, and the first run felt broken.

## Decision

`allowedOwners` defaults to `["*"]`. The policy default stays read-only. An explicitly emptied list still refuses everything, and the UI warns about it.

Configs already saved are not migrated: `config.json` is always written in full, so an empty list written by the old defaults cannot be told apart from one the user chose. A saved empty list stays empty; a config without the field gets the new default.

## Consequences

- A fresh install works for reads on any owner immediately; restrict owners in Auth → Allowed owners.
- Users of the earlier version whose list is empty must add `*` or their owners once.
