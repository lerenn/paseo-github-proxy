# REST path canonicalization

**Status:** Accepted

## Context

The registry review of v0.12.0 (getpaseo/plugins PR #3233) asked for a change: "The REST proxy checks the owner and action before the HTTP client resolves the path. Those steps can identify different repositories. The proxy then sends the request with the configured GitHub credentials. Please publish a Git revision that rejects ambiguous REST paths or checks the final canonical URL before sending it. Apply the same check to the agent tool and the optional client API."

`classifyRest` took the owner from the supplied path text. The request was then sent with `fetch`, which resolves dot segments and decodes some escapes. `/repos/allowed/x/../../victim/y` was classified as owner `allowed` and fetched as `/repos/victim/y`, with the credentials of the App serving whichever owner was reached. Other spellings had the same effect: encoded dots (`%2e%2e`), backslashes, `?` or `#` inside the path, double slashes, and absolute or scheme-relative URLs.

## Decision

1. **One validator, `server/path.ts`.** `canonicalRestPath(path)` returns the path unchanged or throws a `PathError`; it never rewrites. `parseOwner` and `parseRepo` validate names (owner: 1 to 39 letters, digits or hyphens, no leading hyphen; repository: 1 to 100 of letters, digits, `.`, `_`, `-`, not `.` or `..`).
2. **Rejected, not normalized.** A path must start with one `/`; hold only printable ASCII; have no empty segment (`//`, trailing `/`); no `?`, `#` or `\`; no segment equal to `.` or `..`, raw or percent-encoded; no malformed escape; no escape that decodes to `/`, `\` or a control character; and no `%2F` anywhere (tools send slashes raw, for example `heads/feature/x`). Percent-encoding is otherwise allowed only in segments after the repository (a file name, a label), never in the owner or repository segments of `/repos/{owner}/{repo}`, nor the login of `/orgs/{org}` and `/users/{user}`. Absolute URLs, scheme-relative URLs and paths without a leading `/` are refused. The query string travels only in the separate `params` (tools) or the URL query (client API) and is re-serialized with `URLSearchParams`.
3. **One string for everything.** `GithubProxy.rest` validates the path once and uses that string for classification, the policy check, the cache key and the fetch. Just before sending, the URL is built once and parsed back with the WHATWG `URL`: its origin must be the configured API base, its pathname exactly the validated path, its search exactly the serialized query, with no fragment and no credentials. Anything else is refused and nothing is sent.
4. **Every entry point.** `github_api` (REST and GraphQL), every curated tool (they go through `proxy.rest`; their `repo`, `owner`, `user` and `org` arguments are also validated with `parseRepo` and `parseOwner`), the client API `/v1/rest` (the path is passed verbatim, the query separately), `/v1/graphql` (`X-Proxy-Repo`), `/v1/git-credential` and `/v1/git/token` (the same name validators, again in `GitCredentials.token` before `repositories: [name]`), `github_subscribe` and the dry run. The webhook receiver refuses an event whose owner is not a valid owner name.
5. **Denial text.** It addresses the agent, names the rule (plain, unambiguous names and paths) and says not to retry as is.

## Consequences

- Fail closed: some paths that worked by luck are now refused (a trailing slash, a `?query` inside `path`, a full `https://api.github.com/...` URL, non-ASCII characters that were not percent-encoded). `github_api` agents pass the query in `params`.
- A name outside the owner and repository rules (for example a `dependabot[bot]` login in `/users/...`) is refused, though GitHub accepts it. The rules can be widened later in one place.
- Case differences are kept in the URL (GitHub ignores case); the owner allowlist and policy already compare lower-cased names. Two spellings of one repository therefore use separate cache entries, never a shared or poisoned one.
