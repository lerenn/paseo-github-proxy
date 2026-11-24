import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { presetPolicy } from "../shared/config";
import { ConfigStore } from "./store";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "ghp-store-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("ConfigStore", () => {
  it("defaults to read-only with every owner allowed, gh as source and a 30 s TTL", () => {
    const c = new ConfigStore(tmp()).get();
    expect(c).toMatchObject({ activeSource: "gh", fallbackOnRateLimit: false, allowedOwners: ["*"], cacheTtlSeconds: 30, forbidRawGithub: false });
    expect(c.policy.preset).toBe("read_only");
    expect(c.policy.defaultAllow).toEqual(["read", "generic_api_read"]);
  });

  it("persists config, normalizing owners", () => {
    const dir = tmp();
    const s = new ConfigStore(dir);
    s.set({ ...s.get(), allowedOwners: [" Acme ", ""], forbidRawGithub: true, policy: presetPolicy("pr_workflow") });
    const again = new ConfigStore(dir).get();
    expect(again.allowedOwners).toEqual(["acme"]);
    expect(again.forbidRawGithub).toBe(true);
    expect(again.policy.preset).toBe("pr_workflow");
  });

  it("keeps the App key in a 0600 secrets file and never in the config or the view", () => {
    const dir = tmp();
    const s = new ConfigStore(dir);
    s.setAppCredentials({ appId: "12", installationId: "34", privateKey });
    s.set(s.get());
    expect(statSync(path.join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(dir, "config.json"), "utf8")).not.toContain("PRIVATE KEY");
    const view = s.credentialsView();
    expect(JSON.stringify(view)).not.toContain("PRIVATE KEY");
    expect(view).toMatchObject({ configured: true, appId: "12", installationId: "34" });
    expect(view.keyFingerprint).toHaveLength(12);
    expect(new ConfigStore(dir).appCredentials()?.privateKey).toBe(privateKey.trim());
  });

  it("an empty key keeps the stored one; a bad key is refused; clear forgets", () => {
    const s = new ConfigStore(tmp());
    s.setAppCredentials({ appId: "1", installationId: "2", privateKey });
    s.setAppCredentials({ appId: "5", installationId: "2", privateKey: "" });
    expect(s.appCredentials()).toMatchObject({ appId: "5", privateKey: privateKey.trim() });
    expect(() => s.setAppCredentials({ appId: "1", installationId: "2", privateKey: "garbage" })).toThrow(/valid PEM/);
    s.clearAppCredentials();
    expect(s.credentialsView().configured).toBe(false);
  });

  it("recovers from a corrupt config file", () => {
    const dir = tmp();
    new ConfigStore(dir).set({ ...new ConfigStore(dir).get() });
    require("node:fs").writeFileSync(path.join(dir, "config.json"), "{nope");
    expect(new ConfigStore(dir).get().policy.preset).toBe("read_only");
  });
});
