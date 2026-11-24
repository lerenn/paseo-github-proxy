# Webhook listener binds 0.0.0.0 by default

**Status:** Accepted. Supersedes one point of [Webhooks, event-driven cache and agent wake-ups](2026-11-24-webhooks-and-wakeups.md): the default bind address `127.0.0.1`.

## Context

The plugin runs in a Kubernetes pod. GitHub reaches it through a tunnel and a ClusterIP Service, which connect to the pod IP, not to its loopback. A listener on `127.0.0.1` is unreachable there, so the default made the feature fail on the main deployment.

## Decision

The default `webhooks.bind` is `0.0.0.0`, always. Saved configs with an explicit bind are not changed. Users who want loopback only set `127.0.0.1` in the Auth tab. The UI explains both values and shows the listener URL as `http://<this machine>:<port>/webhook` for `0.0.0.0`.

## Consequences

- Any process that can reach the port can send requests. The protection is unchanged: every delivery needs a valid per-App HMAC signature, bodies are capped at 1 MiB, and only `POST /webhook` and `GET /healthz` are served.
- `/healthz` answers without a signature, so it must not be exposed publicly: route only `/webhook` through the tunnel or ingress.
- The listener is still off until the user enables it.
- On a machine with a public interface and no firewall, users who do not want that exposure should set `127.0.0.1`.
