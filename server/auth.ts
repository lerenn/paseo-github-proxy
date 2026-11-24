import { createHash, createSign } from "node:crypto";
import { execFile } from "node:child_process";
import type { SourceId } from "../shared/config";
import type { RateLimitTracker } from "./ratelimit";

export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000, maxBuffer: 1_000_000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve({ stdout, stderr });
    });
  });

export interface AppCredentials {
  appId: string;
  installationId: string;
  privateKey: string;
}

export class AuthError extends Error {}

export type CallStage = "app" | "installation" | "token";

/** A human diagnosis for a refused call, shared by the connection test and the runtime error. */
export function diagnose(status: number, stage: CallStage): string {
  switch (status) {
    case 401:
      return "GitHub rejected the signed JWT: the private key does not belong to this App, the App ID is wrong, or the clock of the daemon machine is off by more than a minute.";
    case 404:
      return stage === "app"
        ? "No App has this App ID. Check the App ID on the App's settings page (About section)."
        : "The installation id does not belong to this App. Find it in the URL of github.com/organizations/<org>/settings/installations/<id> (or github.com/settings/installations/<id> for a user), or with GET /app/installations and the App JWT.";
    case 403:
      return "GitHub refused the request: the App or its installation is suspended, or lacks a permission it needs. Check the installation's settings on GitHub.";
    case 422:
      return "GitHub could not issue a token: the installation may be suspended or the requested permissions are not granted.";
    default:
      return status >= 500 ? `GitHub answered HTTP ${status}: a temporary problem on GitHub's side, try again shortly.` : `GitHub answered HTTP ${status}.`;
  }
}


export interface TokenSource {
  readonly id: SourceId;
  configured(): boolean | Promise<boolean>;
  token(): Promise<string>;
  /** Drop any cached token (after a 401). */
  invalidate(): void;
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

/** A GitHub App JWT (RS256), valid for 9 minutes. */
export function createAppJwt(appId: string, privateKey: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
}

export function keyFingerprint(privateKey: string): string {
  return createHash("sha256").update(privateKey.trim()).digest("hex").slice(0, 12);
}

/** The token of the local `gh` CLI, read with `gh auth token` and kept for five minutes. */
export class GhCliSource implements TokenSource {
  readonly id = "gh" as const;
  private cached: { token: string; at: number } | null = null;

  constructor(
    private readonly exec: ExecFn = defaultExec,
    private readonly clock: () => number = Date.now,
  ) {}

  configured(): boolean {
    return true;
  }

  async token(): Promise<string> {
    if (this.cached && this.clock() - this.cached.at < 300_000) return this.cached.token;
    try {
      const { stdout } = await this.exec("gh", ["auth", "token"]);
      const token = stdout.trim();
      if (!token) throw new AuthError("`gh auth token` returned nothing. Run `gh auth login` on the daemon machine.");
      this.cached = { token, at: this.clock() };
      return token;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new AuthError(code === "ENOENT" ? "The gh CLI is not installed on the daemon machine." : "The gh CLI is not logged in. Run `gh auth login` on the daemon machine.");
    }
  }

  invalidate(): void {
    this.cached = null;
  }

  /** `gh auth status` summary for the Auth tab. */
  async status(): Promise<{ ok: boolean; user: string; detail: string }> {
    try {
      const { stdout } = await this.exec("gh", ["api", "user", "--jq", ".login"]);
      return { ok: true, user: stdout.trim(), detail: "gh is logged in" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { ok: false, user: "", detail: code === "ENOENT" ? "gh is not installed on the daemon machine" : "gh is not logged in (run `gh auth login`)" };
    }
  }
}

/** A GitHub App installation: a JWT is exchanged for an installation token, kept until five minutes before it expires. */
export class AppSource implements TokenSource {
  readonly id = "app" as const;
  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly credentials: () => AppCredentials | null,
    private readonly fetchFn: FetchFn,
    private readonly clock: () => number = Date.now,
    private readonly apiBase = "https://api.github.com",
    private readonly label: () => string = () => "The GitHub App",
  ) {}

  configured(): boolean {
    const c = this.credentials();
    return !!c && !!c.appId && !!c.installationId && !!c.privateKey;
  }

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - this.clock() > 300_000) return this.cached.token;
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  invalidate(): void {
    this.cached = null;
  }

  private async refresh(): Promise<string> {
    const c = this.credentials();
    if (!c || !this.configured()) throw new AuthError(`${this.label()}: the credentials are not configured.`);
    let jwt: string;
    try {
      jwt = createAppJwt(c.appId, c.privateKey, this.clock());
    } catch {
      throw new AuthError(`${this.label()}: the private key is not a valid PEM key.`);
    }
    const response = await this.fetchFn(`${this.apiBase}/app/installations/${encodeURIComponent(c.installationId)}/access_tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": "paseo-github-proxy" },
    });
    const text = await response.text();
    if (response.status !== 201) throw new AuthError(`${this.label()}: GitHub refused the App credentials (HTTP ${response.status}). ${diagnose(response.status, "token")} Do not retry until the credentials are fixed (Auth tab, Test connection).`);
    const parsed = JSON.parse(text) as { token?: string; expires_at?: string };
    if (!parsed.token) throw new AuthError(`${this.label()}: GitHub returned no installation token.`);
    this.cached = { token: parsed.token, expiresAt: parsed.expires_at ? Date.parse(parsed.expires_at) : this.clock() + 3_600_000 };
    return parsed.token;
  }
}

export interface SourceCandidate {
  /** Credential identity: `gh` or `app:<id>`. */
  key: string;
  configured: boolean;
}

export interface SourceChoice {
  /** Credential keys to try, in order. */
  order: string[];
  /** Set when none can be used right now. */
  blocked?: { reason: "unconfigured" | "rate_limited"; until?: number; key: string };
}

/**
 * Picks the credentials to use for a call from the candidates the caller built (the active one first, then the
 * fallback only when it is on). A candidate that is not configured or is rate-limited for the resource is skipped.
 */
export function chooseSources(input: { candidates: SourceCandidate[]; tracker: RateLimitTracker; resource: string }): SourceChoice {
  const order: string[] = [];
  let blocked: SourceChoice["blocked"];
  for (const { key, configured } of input.candidates) {
    if (!configured) {
      blocked ??= { reason: "unconfigured", key };
      continue;
    }
    const until = input.tracker.blockedUntil(key, input.resource);
    if (until !== null) {
      if (!blocked || blocked.reason === "unconfigured" || (blocked.until ?? Infinity) > until) blocked = { reason: "rate_limited", until, key };
      continue;
    }
    order.push(key);
  }
  return order.length ? { order } : { order, blocked };
}
