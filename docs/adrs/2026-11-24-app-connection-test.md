# App connection test

**Status:** Accepted

## Context

An agent reported "GitHub refused the App credentials (HTTP 404)". The old Test connection only asked for a token and said "Not working": it could not tell a wrong installation id (404) from a wrong key or App ID (401), and it only worked on saved credentials.

## Decision

A new RPC, `github-proxy.app.test`, walks the connection step by step: the key signs a JWT, `GET /app`, `GET /app/installations/{id}`, `POST access_tokens`, `GET /rate_limit` with the token, and a comparison of the installation's account with the Organization or user and the extra owners. Each step reports its own result and a human diagnosis; dependent steps are skipped after a failure. On a 404 for the installation, the App's real installations are listed so one tap fills the id.

The test takes the form values and uses the stored private key unless one was typed, so unsaved edits can be tested without being persisted and the key never travels back. The result carries no key or token. The same diagnosis text (`diagnose` in `server/auth.ts`) is used in the runtime error the agent sees.

## Consequences

- Wrong installation ids are found and fixed from the Auth tab.
- The test makes up to five GitHub calls and one token; the token is not cached.
- `github-proxy.source.check` remains for the gh CLI.
