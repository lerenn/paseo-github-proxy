# Policy reference

Order of evaluation for one call:

1. **Scope.** A request that cannot be tied to an owner (for example `/user/repos`, a search without `repo:`/`org:`/`user:`, a GraphQL call without `repo`) is denied unless `*` is an allowed owner.
2. **Allowed owners.** Every owner the call touches must be listed (exact, case-insensitive) or `*`. Default: `*` (all owners). Empty list (cleared by the user): refuse all.
3. **Actions.** The call needs every action it is classified as. For each action: a matching **deny** rule denies; else a matching **allow** rule allows; else the default permissions decide.

## Classification of `github_api`

| Request | Actions needed |
| --- | --- |
| `GET`, `HEAD`, GraphQL query | `generic_api_read` |
| `POST /repos/o/r/issues` | `create_issue` + `generic_api_write` |
| `POST .../issues/N/comments`, `.../pulls/N/comments` | `comment` + `generic_api_write` |
| `POST .../pulls/N/reviews` | `review` + `generic_api_write` |
| `POST /repos/o/r/pulls` | `create_pr` + `generic_api_write` |
| `PATCH/PUT .../pulls/N`, `.../issues/N` | `update_pr` + `generic_api_write` |
| `PUT .../pulls/N/merge`, `POST .../merges` | `merge` + `generic_api_write` |
| `DELETE .../git/refs/...` | `delete_branch` + `generic_api_write` |
| `PATCH .../git/refs/...` with `force: true` | `force_push` + `generic_api_write` |
| anything else that writes | `generic_api_write` |
| GraphQL mutation | `generic_api_write` + the action of each root field (`mergePullRequest` → `merge`, `addComment` → `comment`, `deleteRef` → `delete_branch`, …) |

Curated tools state their action directly and do not need `generic_api_*`.

## Rule patterns

`owner/repo` with `*` matching any run of characters inside one part, case-insensitive: `acme/*`, `*/docs`, `acme/web-*`, `*`.

## Files

`$PASEO_HOME/plugin-data/lerenn/paseo-github-proxy/`: `config.json` (settings, policy), `apps.json` (GitHub Apps, no secret), `secrets.json` (App private keys, 0600), `cache.json` (response cache).
