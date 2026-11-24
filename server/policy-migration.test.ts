import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOG_VERSION, IMPLIED_BY } from "../shared/actions";
import { migratePolicy, policySchema } from "../shared/config";
import { evaluateAction } from "./policy";
import { ConfigStore } from "./store";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "ghp-mig-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const old = (p: unknown) => policySchema.parse(p);
const rule = (over: object) => ({ id: "r", effect: "allow", repos: ["acme/*"], actions: ["create_pr"], reason: "", ...over });

describe("policy migration", () => {
  it("allows create_branch wherever create_pr is allowed, in the default and in rules", () => {
    const m = migratePolicy(old({ preset: "custom", defaultAllow: ["read", "create_pr"], rules: [rule({})] }));
    expect(m.defaultAllow).toContain("create_branch");
    expect(m.rules[0]!.actions).toEqual(["create_pr", "create_branch"]);
    expect(m.actionsVersion).toBe(CATALOG_VERSION);
  });

  it("denies create_branch where a deny rule denies create_pr", () => {
    const m = migratePolicy(old({ preset: "full", defaultAllow: ["read", "create_pr"], rules: [rule({ effect: "deny", repos: ["acme/prod"] })] }));
    expect(evaluateAction(m, "acme/prod", "create_branch").allowed).toBe(false);
    expect(evaluateAction(m, "acme/web", "create_branch").allowed).toBe(true);
  });

  it("keeps read-only read-only", () => {
    const m = migratePolicy(old({ defaultAllow: ["read", "generic_api_read"] }));
    expect(m.defaultAllow).toEqual(["read", "generic_api_read"]);
  });

  it("never implies destructive or admin actions, even with everything old allowed", () => {
    const m = migratePolicy(old({ preset: "custom", defaultAllow: ["read", "comment", "review", "create_issue", "create_pr", "update_pr", "merge", "delete_branch", "force_push", "generic_api_read", "generic_api_write"] }));
    for (const a of ["write_file", "manage_release", "manage_actions", "manage_variables", "create_repo", "edit_repo", "manage_gists", "manage_notifications", "manage_project"]) {
      expect(m.defaultAllow).not.toContain(a);
      expect(IMPLIED_BY[a as keyof typeof IMPLIED_BY]).toBeUndefined();
    }
    expect(m.defaultAllow).toEqual(expect.arrayContaining(["create_branch", "manage_labels", "subscribe_events"]));
  });

  it("leaves rules for all actions alone and is idempotent", () => {
    const p = old({ rules: [rule({ actions: ["*"] }), rule({ actions: [] })] });
    const m = migratePolicy(p);
    expect(m.rules).toEqual(p.rules);
    expect(migratePolicy(m)).toBe(m);
  });

  it("only migrates actions newer than the stored version", () => {
    const m = migratePolicy(old({ actionsVersion: 2, defaultAllow: ["read", "create_pr", "comment"] }));
    expect(m.defaultAllow).toContain("subscribe_events");
    expect(m.defaultAllow).not.toContain("create_branch");
  });

  it("migrates on load, writes the result, and an explicit uncheck afterwards sticks", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ policy: { preset: "custom", defaultAllow: ["read", "create_pr"], rules: [] } }));
    const s = new ConfigStore(dir);
    expect(s.get().policy.defaultAllow).toContain("create_branch");
    expect(JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8")).policy.actionsVersion).toBe(CATALOG_VERSION);
    s.set({ ...s.get(), policy: { ...s.get().policy, defaultAllow: s.get().policy.defaultAllow.filter((a) => a !== "create_branch") } });
    expect(new ConfigStore(dir).get().policy.defaultAllow).not.toContain("create_branch");
  });
});

describe("denial messages", () => {
  it("name the action, the default policy and where to enable it", () => {
    const m = evaluateAction(policySchema.parse({}), "acme/web", "create_branch").message;
    expect(m).toMatch(/default policy/);
    expect(m).toMatch(/enable `create_branch` for the default policy in the Policy tab of the GitHub Proxy plugin/);
    expect(m).toMatch(/Do not retry/);
    expect(m).toMatch(/Plain git commands are not affected/);
  });
  it("name the rule and the repo, and skip the git note for other actions", () => {
    const p = policySchema.parse({ rules: [rule({ effect: "deny", actions: ["merge"] })] });
    const m = evaluateAction(p, "acme/web", "merge").message;
    expect(m).toMatch(/rule #1/);
    expect(m).toMatch(/enable `merge` for acme\/web/);
    expect(m).not.toMatch(/git commands/);
  });
});
