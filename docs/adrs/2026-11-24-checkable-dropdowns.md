# Checkable dropdowns for owners, repositories and actions

## Status

Accepted

## Context

Owners, rule repositories and rule actions were free text or a wall of chips and toggles. Users had to know exact names, and the default permissions took eleven rows.

## Decision

1. One reusable `MultiSelect` in `client/ui-kit.tsx`: a trigger with a summary, a `Modal` sheet (works on mobile, closes on Done or an outside tap) with a checkbox per option, an optional exclusive value (`*` clears the others) and an optional text box for custom values.
2. Used for Allowed owners, default permissions, and each rule's repositories and actions. The config schema is unchanged: the same arrays are read and written.
3. Two new RPCs, `github-proxy.discover.owners` and `github-proxy.discover.repos`, fill the lists. They use `GithubProxy.lookup`, a read-only cached GET through the active source that is not logged as agent activity. Owners: the gh user and `/user/orgs`, or the owners of the App installation's repositories. Repositories: the first 100 per allowed owner (the discovered owners when `*` is allowed), keeping only those the policy lets agents read.
4. Failures degrade: an error message is shown in the sheet and typing a value still works.

## Consequences

- Lists are partial by design (first page, 12 owners); typed patterns cover the rest.
- Discovery uses the owner and repo lists as a convenience, not as authorization: the allowlist and policy are still enforced on every agent call.
- The lookup uses the credentials' rate limit, kept low by the 60 s client cache and the proxy cache.
