import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appEntrySchema, appName, appOwners, presetPolicy, resolveApp } from "../shared/config";
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
    expect(c).toMatchObject({ activeSource: "gh", fallbackOnRateLimit: false, allowedOwners: ["*"], cacheTtlSeconds: 30, forbidRawGithub: false, blockRawGithub: false });
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

  const app = (over: Partial<Parameters<ConfigStore["saveApp"]>[0]> = {}) => ({ organization: "org", appId: "12", installationId: "34", owners: [], default: false, privateKey, ...over });

  it("keeps every App key in a 0600 secrets file and never in the config, the apps file or the view", () => {
    const dir = tmp();
    const s = new ConfigStore(dir);
    const id = s.saveApp(app({ owners: [" Acme "] }));
    s.set(s.get());
    expect(statSync(path.join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
    for (const f of ["config.json", "apps.json"]) expect(readFileSync(path.join(dir, f), "utf8")).not.toContain("PRIVATE KEY");
    const views = s.appViews();
    expect(JSON.stringify(views)).not.toContain("PRIVATE KEY");
    expect(views[0]).toMatchObject({ id, organization: "org", appId: "12", installationId: "34", owners: ["acme"], default: true, configured: true });
    expect(views[0]!.keyFingerprint).toHaveLength(12);
    expect(new ConfigStore(dir).appCredentials(id)?.privateKey).toBe(privateKey.trim());
  });

  it("the first App is the default; a new default replaces it; owners belong to one App", () => {
    const s = new ConfigStore(tmp());
    const a = s.saveApp(app({ organization: "a", appId: "1", owners: ["acme"] }));
    const b = s.saveApp(app({ organization: "b", appId: "2", owners: ["me"], default: true }));
    expect(s.apps().find((x) => x.id === a)!.default).toBe(false);
    expect(s.apps().find((x) => x.id === b)!.default).toBe(true);
    expect(() => s.saveApp(app({ organization: "c", appId: "3", owners: ["acme"] }))).toThrow(/already served by the GitHub App "a"/);
    expect(() => s.saveApp(app({ organization: "c", appId: "2" }))).toThrow(/already configured/);
  });

  it("an empty key keeps the stored one when editing; a bad or missing key is refused; remove forgets", () => {
    const s = new ConfigStore(tmp());
    const id = s.saveApp(app());
    s.saveApp({ ...app({ appId: "5" }), id, privateKey: "" });
    expect(s.appCredentials(id)).toMatchObject({ appId: "5", privateKey: privateKey.trim() });
    expect(() => s.saveApp(app({ organization: "x", appId: "7", privateKey: "garbage" }))).toThrow(/valid PEM/);
    expect(() => s.saveApp(app({ organization: "x", appId: "7", privateKey: "" }))).toThrow(/required/);
    s.removeApp(id);
    expect(s.appViews()).toEqual([]);
    expect(s.appCredentials(id)).toBeNull();
    expect(readFileSync(path.join(s["dir"], "secrets.json"), "utf8")).not.toContain("PRIVATE KEY");
  });

  it("migrates the old single-App secrets to one default App, with nothing lost", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({ app: { appId: "12", installationId: "34", privateKey } }), { mode: 0o600 });
    const first = new ConfigStore(dir);
    expect(first.appViews()).toEqual([{ id: "default", organization: "", label: "GitHub App", appId: "12", installationId: "34", owners: [], default: true, configured: true, keyFingerprint: expect.any(String) }]);
    expect(first.appCredentials("default")).toEqual({ appId: "12", installationId: "34", privateKey });
    // persisted in the new layout: the legacy entry is gone and a reload sees the same App
    const secrets = JSON.parse(readFileSync(path.join(dir, "secrets.json"), "utf8"));
    expect(secrets.app).toBeUndefined();
    expect(secrets.apps.default.privateKey).toBe(privateKey);
    expect(statSync(path.join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(dir, "apps.json"), "utf8")).not.toContain("PRIVATE KEY");
    const again = new ConfigStore(dir);
    expect(again.appCredentials("default")).toEqual({ appId: "12", installationId: "34", privateKey });
    expect(again.apps()).toHaveLength(1);
  });

  it("migrating keeps the config unchanged, and removing the migrated App is not undone on reload", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ activeSource: "app", fallbackOnRateLimit: true, allowedOwners: ["acme"] }));
    writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({ app: { appId: "1", installationId: "2", privateKey } }));
    const s = new ConfigStore(dir);
    expect(s.get()).toMatchObject({ activeSource: "app", fallbackOnRateLimit: true, allowedOwners: ["acme"] });
    s.removeApp("default");
    expect(new ConfigStore(dir).apps()).toEqual([]);
  });

  it("a crash after the new key was written but before the old one was dropped loses nothing", () => {
    const dir = tmp();
    const s = new ConfigStore(dir);
    const id = s.saveApp(app());
    // leave the legacy entry behind, as an interrupted migration would
    writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({ app: { appId: "12", installationId: "34", privateKey }, apps: { [id]: { privateKey } } }));
    const again = new ConfigStore(dir);
    expect(again.appCredentials(id)?.privateKey).toBe(privateKey);
    expect(JSON.parse(readFileSync(path.join(dir, "secrets.json"), "utf8")).app).toBeUndefined();
  });

  it("recovers from a corrupt config file", () => {
    const dir = tmp();
    new ConfigStore(dir).set({ ...new ConfigStore(dir).get() });
    require("node:fs").writeFileSync(path.join(dir, "config.json"), "{nope");
    expect(new ConfigStore(dir).get().policy.preset).toBe("read_only");
  });
  it("claims the organization automatically, compares owners case-insensitively and never duplicates it", () => {
    const s = new ConfigStore(tmp());
    const a = s.saveApp(app({ organization: " Acme ", appId: "1", owners: ["ACME", "Extra", "extra"] }));
    expect(s.apps().find((x) => x.id === a)).toMatchObject({ organization: "acme", owners: ["extra"] });
    expect(appOwners(s.apps()[0]!)).toEqual(["acme", "extra"]);
    expect(() => s.saveApp(app({ organization: "ACME", appId: "2" }))).toThrow(/The owner "acme" is already served by the GitHub App "acme"/);
    expect(() => s.saveApp(app({ organization: "other", appId: "3", owners: ["Extra"] }))).toThrow(/"extra" is already served by the GitHub App "acme"/);
    expect(() => s.saveApp(app({ organization: "not valid!", appId: "4" }))).toThrow(/not a valid GitHub/);
    expect(resolveApp(s.apps(), "ACME")?.id).toBe(a);
    expect(resolveApp(s.apps(), "Extra")?.id).toBe(a);
    expect(resolveApp(s.apps(), "nobody")?.id).toBe(a); // the only App is the default
  });

  it("never ends with two default Apps: saving one default clears the others, and a stored double default is repaired", () => {
    const dir = tmp();
    const s = new ConfigStore(dir);
    const a = s.saveApp(app({ organization: "a", appId: "1" }));
    const b = s.saveApp(app({ organization: "b", appId: "2", default: true }));
    expect(s.apps().filter((x) => x.default).map((x) => x.id)).toEqual([b]);
    s.saveApp({ ...app({ organization: "a", appId: "1", default: true }), id: a, privateKey: "" });
    expect(s.apps().filter((x) => x.default).map((x) => x.id)).toEqual([a]);
    writeFileSync(path.join(dir, "apps.json"), JSON.stringify({ apps: s.apps().map((x) => ({ ...x, default: true })) }));
    expect(new ConfigStore(dir).apps().filter((x) => x.default)).toHaveLength(1);
  });

  it("migrates old Apps: a valid owner-name label with no owners becomes the organization, anything else keeps its label and owners", () => {
    const parse = (o: object) => appEntrySchema.parse({ id: "x", appId: "1", installationId: "2", default: false, ...o });
    expect(parse({ label: "Acme", owners: [] })).toMatchObject({ organization: "acme", label: "", owners: [] });
    expect(parse({ label: "Acme", owners: ["acme"] })).toMatchObject({ organization: "", label: "Acme", owners: ["acme"] });
    expect(parse({ label: "Acme org", owners: [] })).toMatchObject({ organization: "", label: "Acme org", owners: [] });
    expect(parse({ label: "GitHub App" })).toMatchObject({ organization: "", label: "GitHub App", owners: [] });
    expect(parse({ organization: "acme", owners: ["x"] })).toMatchObject({ organization: "acme", label: "", owners: ["x"] });
    const dir = tmp();
    writeFileSync(path.join(dir, "apps.json"), JSON.stringify({ apps: [{ id: "a", label: "acme", appId: "1", installationId: "2", owners: [], default: false }, { id: "b", label: "Team", appId: "3", installationId: "4", owners: ["me"], default: true }] }));
    const s = new ConfigStore(dir);
    expect(s.apps().map((x) => [appName(x), appOwners(x), x.default])).toEqual([["acme", ["acme"], false], ["Team", ["me"], true]]);
  });
});
