import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { GitHubClient } from "./github";
import { RateLimiter } from "./limiter";
import { TokenStore } from "./tokens";

export const tmp = () => mkdtempSync(path.join(tmpdir(), "ghp-"));

export const PR = {
  number: 7, title: "Add thing", state: "open", merged_at: null, draft: false, body: "Body text", html_url: "https://github.com/acme/app/pull/7",
  user: { login: "ada", type: "User", node_id: "U1" }, head: { ref: "feat", sha: "abc123" }, base: { ref: "main" }, mergeable: true,
  labels: [{ name: "bug", color: "f00", description: null }], assignees: [], requested_reviewers: [{ login: "bob", node_id: "U2" }], requested_teams: [],
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", closed_at: null, additions: 3, deletions: 1, changed_files: 2, merge_commit_sha: null,
};

export const CHECK_RUNS = {
  check_runs: [
    { name: "ci", status: "completed", conclusion: "success", html_url: "https://x/ci", app: { name: "GitHub Actions" }, output: { title: "ok" }, started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:01:05Z" },
    { name: "lint", status: "in_progress", conclusion: null, html_url: "https://x/lint", app: { name: "GitHub Actions" }, output: {}, started_at: "2026-01-01T00:00:00Z", completed_at: null },
  ],
};

/** Fake GitHub: exact path (with query) -> body, or a function returning a Response. Records calls. */
export function fakeGithub(routes: Record<string, unknown | ((init: RequestInit) => Response)>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const key = url.replace("https://api.github.com", "");
    calls.push({ url: key, init });
    const route = routes[key];
    if (route === undefined) return new Response(JSON.stringify({ message: `no route ${key}` }), { status: 404 });
    if (typeof route === "function") return (route as (i: RequestInit) => Response)(init);
    return new Response(typeof route === "string" ? route : JSON.stringify(route), { status: 200, headers: { "content-type": "application/json" } });
  };
  const tokens = new TokenStore(path.join(tmp(), "tokens.json"));
  tokens.set("acme", "tok_acme");
  const client = new GitHubClient({ tokens, limiter: new RateLimiter({ writeGapMs: 0 }), fetch: vi.fn(impl) as unknown as typeof fetch });
  return { client, calls, tokens };
}

export const standardRoutes = {
  "/repos/acme/app/pulls/7": PR,
  "/repos/acme/app/commits/abc123/check-runs?per_page=100": CHECK_RUNS,
  "/repos/acme/app/commits/abc123/status": { statuses: [{ context: "legacy", state: "failure", target_url: "https://x/l", description: "bad", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:10Z" }] },
  "/repos/acme/app/pulls?head=acme%3Afeat&state=all&per_page=1": [PR],
  "/repos/acme/app/pulls/7/files?per_page=100": [{ filename: "a.ts", additions: 3, deletions: 1, status: "modified" }],
};

/** Fake GitHub driven by one function (path with query -> body or Response); records calls. */
export function dynamicGithub(handler: (path: string, init: RequestInit) => unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const key = String(input).replace("https://api.github.com", "");
    calls.push({ url: key, init });
    const out = handler(key, init);
    if (out instanceof Response) return out;
    if (out === undefined) return new Response(JSON.stringify({ message: `no route ${key}` }), { status: 404 });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  const tokens = new TokenStore(path.join(tmp(), "tokens.json"));
  tokens.set("acme", "tok_acme");
  const client = new GitHubClient({ tokens, limiter: new RateLimiter({ writeGapMs: 0 }), fetch: vi.fn(impl) as unknown as typeof fetch });
  return { client, calls, tokens };
}
