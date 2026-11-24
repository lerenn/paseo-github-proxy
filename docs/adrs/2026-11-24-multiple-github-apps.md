# Several GitHub Apps, one per owner

**Status**: Accepted. Extends `2026-11-24-in-plugin-proxy.md` (one App) and keeps `2026-11-24-default-allow-all-owners.md`.

## Context

A GitHub App is installed by one account, so a private App cannot serve both an organization and a user. The internal Go service this plugin ports already supports several Apps (one per owner, plus a default one). The plugin held exactly one App: one credential record in `secrets.json`, one token source, one rate-limit bucket named `app`.

## Decision

1. **Model.** A list of Apps: stable `id` (slug), `label`, `appId`, `installationId`, `owners` (lower-cased, never `*`) and a `default` flag. At most one is the default; the first one added becomes it. An owner belongs to one App, an App ID to one entry, a label to one entry. The installation id stays required (the plugin does not discover it).
2. **Storage.** Non-secret fields go to `apps.json`, so the client's `config.save` cannot clobber them. Private keys go only to `secrets.json` (0600) as `{ apps: { <id>: { privateKey } } }`. The client sees `AppCredentialsView` per App: no key, a fingerprint. App changes have their own RPCs (`app.save` upserts one App, `app.clear` removes one).
3. **Migration.** The old `secrets.json` `{ app: { appId, installationId, privateKey } }` becomes one default App (id `default`, label "GitHub App", no owners). The key is written in the new layout first, then `apps.json`, then the legacy entry is dropped, so an interruption loses nothing. `config.json` is untouched.
4. **Routing.** `activeSource` keeps its meaning (`gh` or `app`). With `app`, after the owner allowlist and policy, the call uses the App claiming its owner, else the default App; a call with no owner uses the default App. A call spanning owners of different Apps is refused (split it). With no App for the owner, the agent gets a message naming the owner and not to retry, unless the fallback is on and `gh` answers. The fallback still means "the other source": with `app` active, `gh`; with `gh` active, the App serving the owner.
5. **Per-credential state.** A credential is `gh` or `app:<id>`. Each App has its own JWT and installation-token cache (`AppPool`), and the rate-limit tracker and blocks are keyed by credential. Overview lists `gh` and every App; Activity entries carry the App label.
6. **Cache isolation.** The cache key includes the credential identity, so what one App or `gh` saw (a private repository) is never served to another. A stale answer is served only from a credential the call could have used. Old cache entries, without an identity, no longer match and age out.
7. **Discovery.** Owner discovery asks every App for its installation repositories and merges the owners, reporting an App that fails without hiding the others. Repository discovery reads each owner through the App that serves it.

## Consequences

- One App cannot see another's repositories even by name: asking about an owner always goes through that owner's App.
- `config.get` returns `apps` instead of `app`; `app.save`, `app.clear` and `source.check` take an App id. The Auth tab and the plugin RPC contracts changed accordingly, hence a minor version bump.
- Calls that name no owner (`/user`, `/rate_limit`) go through the default App; with no default App they are refused when `app` is active.
- A cache written before the upgrade is not reused once.
