# GitHub App organization field

**Status**: Accepted. Refines the App model of `2026-11-24-multiple-github-apps.md` (its `label` and `owners` fields).

## Context

An App form asked for a free "Label" and a separate "Owners this App serves" dropdown. In practice the label was the account name and had to be repeated in the owners list; a forgotten owner meant the App served nothing.

## Decision

1. `label` becomes `organization`: the GitHub account the App is installed on (for example `acme`). It is the App's name in the collapsed row, Overview, Activity and tabs, and it is claimed automatically for routing, discovery and rate-limit cards.
2. `owners` stays in storage and is shown as "Also serves": optional extra owners covered by the same installation. The organization is removed from it, owners are lower-cased, and an owner (organization or extra) can belong to one App only; saving a clash is refused naming the owner and the other App.
3. "Default App" stays an explicit catch-all. At most one App is the default: saving a default clears the others in the store, a stored config with several keeps the first, and the client follows the saved state.
4. Migration is in the schema, so old `apps.json` parse. If `organization` is absent: the old `label` becomes the organization when it is a valid GitHub account name and the App has no owners; otherwise the label stays as a display name (`label`) with `organization` empty, and the owners stay as they are. No account is guessed. Saving such an App with an organization replaces the display name.

## Consequences

- One field fewer to fill; the common case needs no dropdown.
- Migrated Apps with a free-form label keep working exactly as before. An App without organization and without owners still serves only as the default.
- A label that happens to be a valid name but whose account another App already claims is not detected at load; routing takes the first match.
