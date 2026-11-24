import { createPrivateKey } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { configSchema, defaultConfig, type AppCredentialsView, type Config } from "../shared/config";
import { keyFingerprint, type AppCredentials } from "./auth";

/** `$PASEO_HOME/plugin-data/lerenn/paseo-github-proxy`. */
export function dataDir(): string {
  return path.join(process.env.PASEO_HOME || path.join(homedir(), ".paseo"), "plugin-data", "lerenn", "paseo-github-proxy");
}

function writeJson(file: string, value: unknown, mode: number): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  renameSync(tmp, file);
  chmodSync(file, mode);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The plugin's configuration (`config.json`) and its secrets (`secrets.json`, mode 0600, never sent to the client).
 * Paseo has no secret vault for plugins, so the App private key lives in a file only the daemon's user can read.
 */
export class ConfigStore {
  private config: Config;
  private credentials: AppCredentials | null;

  constructor(private readonly dir: string) {
    const parsed = configSchema.safeParse(readJson(path.join(dir, "config.json")) ?? {});
    this.config = parsed.success ? parsed.data : defaultConfig();
    const secrets = readJson(path.join(dir, "secrets.json")) as { app?: Partial<AppCredentials> } | null;
    const app = secrets?.app;
    this.credentials = app?.appId && app.installationId && app.privateKey ? { appId: app.appId, installationId: app.installationId, privateKey: app.privateKey } : null;
  }

  get(): Config {
    return this.config;
  }

  set(next: Config): Config {
    const parsed = configSchema.parse({ ...next, allowedOwners: next.allowedOwners.map((o) => o.trim().toLowerCase()).filter(Boolean) });
    this.config = parsed;
    writeJson(path.join(this.dir, "config.json"), parsed, 0o600);
    return parsed;
  }

  credentialsView(): AppCredentialsView {
    const c = this.credentials;
    return { configured: !!c, appId: c?.appId ?? "", installationId: c?.installationId ?? "", keyFingerprint: c ? keyFingerprint(c.privateKey) : "" };
  }

  appCredentials(): AppCredentials | null {
    return this.credentials;
  }

  /** Saves the App credentials. An empty key keeps the stored one (so the form can change ids without re-entering it). */
  setAppCredentials(input: { appId: string; installationId: string; privateKey: string }): void {
    const privateKey = input.privateKey.trim() || this.credentials?.privateKey || "";
    if (!input.appId.trim() || !input.installationId.trim() || !privateKey) throw new Error("App ID, installation id and private key are all required.");
    try {
      createPrivateKey(privateKey);
    } catch {
      throw new Error("The private key is not a valid PEM key.");
    }
    this.credentials = { appId: input.appId.trim(), installationId: input.installationId.trim(), privateKey };
    writeJson(path.join(this.dir, "secrets.json"), { app: this.credentials }, 0o600);
  }

  clearAppCredentials(): void {
    this.credentials = null;
    writeJson(path.join(this.dir, "secrets.json"), {}, 0o600);
  }
}
