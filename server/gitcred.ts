import type { Action } from "../shared/actions";
import { resolveApp, type AppEntry } from "../shared/config";
import { AuthError, createAppJwt, type AppCredentials, type FetchFn } from "./auth";
import { ProxyError, type CallContext } from "./proxy";

/** A token is reused until this long before it expires. */
export const TOKEN_MARGIN_MS = 5 * 60_000;

export type GitAccess = "read" | "write";

/** What each kind of token may do. Metadata is always read; the helper protocol cannot tell a fetch from a push. */
export const PERMISSIONS: Record<GitAccess, Record<string, string>> = {
  read: { contents: "read", metadata: "read" },
  write: { contents: "write", metadata: "read" },
};

export interface GitToken {
  username: "x-access-token";
  password: string;
  expiresAt: number;
  repository: string;
  access: GitAccess;
  app: string;
}

/** The repository named by the path git sends (`owner/repo.git` or `owner/repo`), or null for anything else. */
export function repoFromGitPath(path: string): { owner: string; name: string } | null {
  const parts = path.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0]!;
  const name = parts[1]!.replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") return null;
  return { owner, name };
}

export interface GitCredDeps {
  /** The apps and the policy check come from the proxy: same owner allowlist, same rules as every other call. */
  proxy: {
    judgeAction(repo: string, actions: Action[]): { allowed: boolean; message: string };
    authorize(ctx: CallContext, repo: string, actions: Action[], detail?: string): void;
  };
  apps: () => AppEntry[];
  credentials: (appId: string) => AppCredentials | null;
  fetch: FetchFn;
  clock?: () => number;
  apiBase?: string;
}

/**
 * The git credential endpoint: an installation token of the GitHub App serving the owner, limited to one repository
 * and to the permissions the policy grants. Tokens are cached per (App, repository, access) until five minutes before
 * they expire. Tokens are never logged and never put in an error message.
 */
export class GitCredentials {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<{ token: string; expiresAt: number }>>();
  private readonly clock: () => number;
  private readonly base: string;
  minted = 0;
  reused = 0;

  constructor(private readonly deps: GitCredDeps) {
    this.clock = deps.clock ?? Date.now;
    this.base = deps.apiBase ?? "https://api.github.com";
  }

  /**
   * `access` unset: the policy decides (write when `write_file` and `create_branch` are both allowed for the repo, else
   * read). `"read"` asks for the read token whatever the policy allows. `"write"` is refused unless the policy allows it.
   */
  async token(ctx: CallContext, owner: string, name: string, access?: GitAccess): Promise<GitToken> {
    const repo = `${owner}/${name}`.toLowerCase();
    const writeVerdict = access === "read" ? null : this.deps.proxy.judgeAction(repo, ["write_file", "create_branch"]);
    if (access === "write" && !writeVerdict!.allowed) {
      this.deps.proxy.authorize(ctx, repo, ["write_file", "create_branch"]); // records the denial and throws it
    }
    const granted: GitAccess = writeVerdict?.allowed ? "write" : "read";
    this.deps.proxy.authorize(ctx, repo, granted === "write" ? ["read", "write_file", "create_branch"] : ["read"], `git ${granted} token`);

    const app = resolveApp(this.deps.apps(), owner);
    if (!app) throw new ProxyError("auth", `No GitHub App serves the owner "${owner}". The git credential helper needs a GitHub App (the gh CLI cannot issue scoped tokens). Ask the user to assign the owner to an App, or mark a default App, in GitHub Proxy → Auth.`, 503);
    const key = `${app.id}|${repo}|${granted}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt - this.clock() > TOKEN_MARGIN_MS) {
      this.reused++;
      return { username: "x-access-token", password: hit.token, expiresAt: hit.expiresAt, repository: repo, access: granted, app: app.id };
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.mint(app, name, granted).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const fresh = await pending;
    this.cache.set(key, fresh);
    return { username: "x-access-token", password: fresh.token, expiresAt: fresh.expiresAt, repository: repo, access: granted, app: app.id };
  }

  /** Forgets every cached token (a changed App). */
  clear(): void {
    this.cache.clear();
  }

  private async mint(app: AppEntry, name: string, access: GitAccess): Promise<{ token: string; expiresAt: number }> {
    const creds = this.deps.credentials(app.id);
    if (!creds || !creds.appId || !creds.installationId || !creds.privateKey) throw new ProxyError("auth", `The GitHub App "${app.organization || app.label || app.id}" has no credentials. Ask the user to complete it in GitHub Proxy → Auth.`, 503);
    let jwt: string;
    try {
      jwt = createAppJwt(creds.appId, creds.privateKey, this.clock());
    } catch {
      throw new ProxyError("auth", "The GitHub App private key is not a valid PEM key.", 503);
    }
    const res = await this.deps.fetch(`${this.base}/app/installations/${encodeURIComponent(creds.installationId)}/access_tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "paseo-github-proxy" },
      body: JSON.stringify({ repositories: [name], permissions: PERMISSIONS[access] }),
    });
    const text = await res.text();
    if (res.status !== 201) {
      const hint =
        res.status === 422 ? ` The App does not have the permission requested (Contents: ${access === "write" ? "Read and write" : "Read-only"}); ask the user to grant it in the App settings and accept it on the installation.`
        : res.status === 404 ? " The App is not installed on that repository, or the repository does not exist."
        : "";
      throw new ProxyError("http", `GitHub refused to issue a ${access} token for ${name} (HTTP ${res.status}).${hint} Do not retry as is.`, res.status === 422 || res.status === 404 ? 502 : res.status);
    }
    let parsed: { token?: string; expires_at?: string };
    try {
      parsed = JSON.parse(text) as { token?: string; expires_at?: string };
    } catch {
      parsed = {};
    }
    if (!parsed.token) throw new AuthError("GitHub returned no installation token.");
    this.minted++;
    return { token: parsed.token, expiresAt: parsed.expires_at ? Date.parse(parsed.expires_at) : this.clock() + 3_600_000 };
  }
}
