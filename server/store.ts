import { createPrivateKey, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CATALOG_VERSION } from "../shared/actions";
import { z } from "zod";
import { migratePolicy, appEntrySchema, appName, appOwners, isOwnerName, configSchema, defaultConfig, type AppCredentialsView, type AppEntry, type Config } from "../shared/config";
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

export interface AppInput {
  /** Empty to add an App. */
  id?: string;
  /** The GitHub account the App is installed on; claimed automatically. */
  organization: string;
  /** Legacy display name of an App without organization; ignored when an organization is given. */
  label?: string;
  appId: string;
  installationId: string;
  owners: string[];
  default: boolean;
  /** Empty keeps the stored key of an existing App. */
  privateKey: string;
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "app";
/** Config never ends with two default Apps: the first one (in stored order) keeps it. */
const singleDefault = (apps: AppEntry[]): AppEntry[] => {
  let seen = false;
  return apps.map((a) => (a.default && seen ? { ...a, default: false } : ((seen ||= a.default), a)));
};
const normOwners = (owners: string[]): string[] => [...new Set(owners.map((o) => o.trim().toLowerCase()).filter((o) => o && o !== "*"))];

/**
 * The plugin's configuration (`config.json`), its GitHub Apps (`apps.json`: labels, ids and owners, no secret) and its
 * secrets (`secrets.json`, mode 0600, never sent to the client: one private key per App id).
 * Paseo has no secret vault for plugins, so the keys live in a file only the daemon's user can read.
 *
 * Versions before 0.2 kept one App in `secrets.json` as `{ app: { appId, installationId, privateKey } }`. On first read it
 * becomes one default App (label "GitHub App"), with nothing lost.
 */
export class ConfigStore {
  private config: Config;
  private appList: AppEntry[] = [];
  private keys = new Map<string, string>();
  /** Webhook secrets, per App id. Same file as the keys, same rules: never logged, never sent to the client. */
  private hookSecrets = new Map<string, string>();
  /** The client API bearer token. Same file, same rules: never logged, never sent to the client after it was generated. */
  private clientTokenValue = "";

  constructor(private readonly dir: string) {
    const parsed = configSchema.safeParse(readJson(path.join(dir, "config.json")) ?? {});
    this.config = parsed.success ? parsed.data : defaultConfig();
    const migrated = migratePolicy(this.config.policy);
    if (migrated !== this.config.policy) {
      this.config = { ...this.config, policy: migrated };
      try {
        writeJson(path.join(dir, "config.json"), this.config, 0o600);
      } catch (error) {
        console.error("[github-proxy] could not save the migrated policy:", (error as Error).message);
      }
    }
    const secrets = readJson(path.join(dir, "secrets.json")) as { clientToken?: string; app?: Partial<AppCredentials>; apps?: Record<string, { privateKey?: string; webhookSecret?: string }> } | null;
    if (typeof secrets?.clientToken === "string") this.clientTokenValue = secrets.clientToken;
    for (const [id, v] of Object.entries(secrets?.apps ?? {})) {
      if (typeof v?.privateKey === "string" && v.privateKey) this.keys.set(id, v.privateKey);
      if (typeof v?.webhookSecret === "string" && v.webhookSecret) this.hookSecrets.set(id, v.webhookSecret);
    }
    const stored = readJson(path.join(dir, "apps.json")) as { apps?: unknown } | null;
    if (stored) {
      const list = z.array(appEntrySchema).safeParse(stored.apps ?? []);
      this.appList = list.success ? singleDefault(list.data as AppEntry[]) : [];
      // A crash between the migration steps can leave the old entry behind: drop it.
      if (secrets?.app) this.writeSecrets();
    } else if (secrets?.app?.appId && secrets.app.installationId && secrets.app.privateKey) {
      this.migrate(secrets.app as AppCredentials);
    }
  }

  /** Legacy single App → one default App. The key is written under its new place before anything is removed. */
  private migrate(legacy: AppCredentials): void {
    const id = "default";
    this.keys.set(id, legacy.privateKey);
    this.appList = [{ id, organization: "", label: "GitHub App", appId: legacy.appId, installationId: legacy.installationId, owners: [], default: true }];
    try {
      writeJson(path.join(this.dir, "secrets.json"), { app: legacy, apps: { [id]: { privateKey: legacy.privateKey } } }, 0o600);
      this.writeApps();
      this.writeSecrets();
    } catch (error) {
      console.error("[github-proxy] could not save the migrated GitHub App:", (error as Error).message);
    }
  }

  private writeApps(): void {
    writeJson(path.join(this.dir, "apps.json"), { apps: this.appList }, 0o600);
  }

  private writeSecrets(): void {
    writeJson(path.join(this.dir, "secrets.json"), { ...(this.clientTokenValue ? { clientToken: this.clientTokenValue } : {}), apps: Object.fromEntries([...this.keys].map(([id, privateKey]) => [id, { privateKey, ...(this.hookSecrets.has(id) ? { webhookSecret: this.hookSecrets.get(id) } : {}) }])) }, 0o600);
  }

  get(): Config {
    return this.config;
  }

  set(next: Config): Config {
    const parsed = configSchema.parse({ ...next, allowedOwners: next.allowedOwners.map((o) => o.trim().toLowerCase()).filter(Boolean) });
    // What the user saves is their decision for every action of the catalog: stamp it so it is never migrated again.
    const saved = { ...parsed, policy: { ...parsed.policy, actionsVersion: CATALOG_VERSION } };
    this.config = saved;
    writeJson(path.join(this.dir, "config.json"), saved, 0o600);
    return saved;
  }

  apps(): AppEntry[] {
    return this.appList;
  }

  /** The Apps as the client sees them: the key is replaced by a fingerprint. */
  appViews(): AppCredentialsView[] {
    return this.appList.map((a) => {
      const key = this.keys.get(a.id);
      return { ...a, configured: !!(key && a.appId && a.installationId), webhookSecretSet: this.hookSecrets.has(a.id), keyFingerprint: key ? keyFingerprint(key) : "" };
    });
  }

  appCredentials(id: string): AppCredentials | null {
    const app = this.appList.find((a) => a.id === id);
    const privateKey = this.keys.get(id);
    return app && privateKey ? { appId: app.appId, installationId: app.installationId, privateKey } : null;
  }

  /** The Apps that have a webhook secret, with the secret. Server side only: for verifying deliveries. */
  webhookSecrets(): { app: AppEntry; secret: string }[] {
    return this.appList.flatMap((app) => (this.hookSecrets.has(app.id) ? [{ app, secret: this.hookSecrets.get(app.id)! }] : []));
  }

  /** Stores a new random webhook secret for an App and returns it, once: it can not be read back. */
  generateWebhookSecret(id: string): string {
    if (!this.appList.some((a) => a.id === id)) throw new Error("That GitHub App no longer exists.");
    const secret = randomBytes(32).toString("hex");
    this.hookSecrets.set(id, secret);
    this.writeSecrets();
    return secret;
  }

  clearWebhookSecret(id: string): void {
    if (this.hookSecrets.delete(id)) this.writeSecrets();
  }

  /** The client API bearer token, or "" when none is set. Server side only. */
  clientToken(): string {
    return this.clientTokenValue;
  }

  /** Stores a new random client API token and returns it, once for the screen. */
  generateClientToken(): string {
    this.clientTokenValue = `pgp_${randomBytes(24).toString("hex")}`;
    this.writeSecrets();
    return this.clientTokenValue;
  }

  clearClientToken(): void {
    if (!this.clientTokenValue) return;
    this.clientTokenValue = "";
    this.writeSecrets();
  }

  /** Adds or edits an App; returns its id. An empty key keeps the stored one. Errors are written for the user. */
  saveApp(input: AppInput): string {
    const existing = input.id ? this.appList.find((a) => a.id === input.id) : undefined;
    if (input.id && !existing) throw new Error("That GitHub App no longer exists.");
    const organization = input.organization.trim().toLowerCase();
    const label = organization ? "" : (input.label ?? existing?.label ?? "").trim();
    const appId = input.appId.trim();
    const installationId = input.installationId.trim();
    const privateKey = input.privateKey.trim() || (existing ? this.keys.get(existing.id) : "") || "";
    if ((!organization && !label) || !appId || !installationId || !privateKey) throw new Error("An organization or user, App ID, installation id and private key are all required.");
    if (organization && !isOwnerName(organization)) throw new Error(`"${input.organization.trim()}" is not a valid GitHub organization or user name.`);
    try {
      createPrivateKey(privateKey);
    } catch {
      throw new Error("The private key is not a valid PEM key.");
    }
    const others = this.appList.filter((a) => a.id !== existing?.id);
    if (others.some((a) => a.appId === appId)) throw new Error(`App ID ${appId} is already configured.`);
    const owners = normOwners(input.owners).filter((o) => o !== organization);
    for (const owner of appOwners({ organization, owners })) {
      const taken = others.find((a) => appOwners(a).includes(owner));
      if (taken) throw new Error(`The owner "${owner}" is already served by the GitHub App "${appName(taken)}". An owner can belong to one App only.`);
    }
    const name = organization || label;
    let id = existing?.id ?? slug(name);
    if (!existing) for (let n = 2; this.appList.some((a) => a.id === id); n++) id = `${slug(name)}-${n}`;
    const makeDefault = input.default || (!existing && others.length === 0);
    const entry: AppEntry = { id, organization, label, appId, installationId, owners, default: makeDefault };
    this.appList = [...others.map((a) => (makeDefault ? { ...a, default: false } : a)), entry].sort((a, b) => Number(b.default) - Number(a.default) || appName(a).localeCompare(appName(b)));
    this.keys.set(id, privateKey);
    this.writeSecrets();
    this.writeApps();
    return id;
  }

  removeApp(id: string): void {
    this.appList = this.appList.filter((a) => a.id !== id);
    this.keys.delete(id);
    this.hookSecrets.delete(id);
    this.writeApps();
    this.writeSecrets();
  }
}
