import { describe, expect, it } from "vitest";
import { presetPolicy, type Rule } from "../shared/config";
import { evaluate, evaluateAction, matchRepo, ownerAllowed } from "./policy";

const rule = (r: Partial<Rule>): Rule => ({ id: "x", effect: "allow", repos: ["*"], actions: ["*"], reason: "", ...r });

describe("matchRepo", () => {
  it("matches globs inside a segment, case-insensitively", () => {
    expect(matchRepo("acme/*", "Acme/web")).toBe(true);
    expect(matchRepo("acme/web-*", "acme/web-ui")).toBe(true);
    expect(matchRepo("acme/web-*", "acme/api")).toBe(false);
    expect(matchRepo("*/docs", "other/docs")).toBe(true);
    expect(matchRepo("*", "a/b")).toBe(true);
    expect(matchRepo("acme/*", "acme2/web")).toBe(false);
    expect(matchRepo("acme/web", "acme/web.js")).toBe(false);
  });
});

describe("evaluate", () => {
  it("read-only allows reads and denies writes by default, naming the default policy", () => {
    const p = presetPolicy("read_only");
    expect(evaluateAction(p, "a/b", "read").allowed).toBe(true);
    const d = evaluateAction(p, "a/b", "merge");
    expect(d.allowed).toBe(false);
    expect(d.message).toMatch(/default policy \(read-only\)/);
    expect(d.message).toMatch(/Do not retry/);
  });

  it("pr_workflow allows comments and PRs but not merges", () => {
    const p = presetPolicy("pr_workflow");
    expect(evaluate(p, "a/b", ["create_pr"]).allowed).toBe(true);
    expect(evaluate(p, "a/b", ["comment", "review"]).allowed).toBe(true);
    expect(evaluate(p, "a/b", ["merge"]).allowed).toBe(false);
    expect(evaluate(p, "a/b", ["delete_branch"]).allowed).toBe(false);
  });

  it("an allow rule opens an action for matching repos only", () => {
    const p = presetPolicy("read_only", [rule({ repos: ["lerenn/*"], actions: ["comment", "create_pr"] })]);
    expect(evaluateAction(p, "lerenn/x", "comment").allowed).toBe(true);
    expect(evaluateAction(p, "acme/x", "comment").allowed).toBe(false);
  });

  it("a deny rule beats an allow rule and the full preset, and names itself and its reason", () => {
    const p = presetPolicy("full", [rule({ id: "no-merge", effect: "deny", repos: ["acme/prod"], actions: ["merge", "delete_branch"], reason: "prod is human-only" })]);
    const d = evaluateAction(p, "acme/prod", "merge");
    expect(d.allowed).toBe(false);
    expect(d.rule?.index).toBe(0);
    expect(d.message).toMatch(/rule #1/);
    expect(d.message).toMatch(/prod is human-only/);
    expect(evaluateAction(p, "acme/other", "merge").allowed).toBe(true);
  });

  it("requires every action of a multi-action call", () => {
    const p = presetPolicy("pr_workflow");
    // a generic write that is also a comment: the generic write is still denied
    const d = evaluate(p, "a/b", ["comment", "generic_api_write"]);
    expect(d.allowed).toBe(false);
    expect(d.action).toBe("generic_api_write");
  });
});

describe("ownerAllowed", () => {
  it("is exact, case-insensitive, supports * and refuses when empty", () => {
    expect(ownerAllowed(["Acme"], "acme")).toBe(true);
    expect(ownerAllowed(["acme"], "acme-evil")).toBe(false);
    expect(ownerAllowed(["acme"], "ac")).toBe(false);
    expect(ownerAllowed(["*"], "anyone")).toBe(true);
    expect(ownerAllowed([], "acme")).toBe(false);
    expect(ownerAllowed(["*"], "")).toBe(false);
  });
});

describe("default policy", () => {
  it("Full is exactly the whole catalog and a fresh config allows every kind of write", async () => {
    const { ACTIONS, PRESET_INFO } = await import("../shared/actions");
    const { defaultConfig } = await import("../shared/config");
    expect([...PRESET_INFO.full.allow]).toEqual([...ACTIONS]);
    expect(presetPolicy("full").actionsVersion).toBe((await import("../shared/actions")).CATALOG_VERSION);
    const { policy } = defaultConfig();
    expect(policy.preset).toBe("full");
    for (const a of ["create_branch", "write_file", "merge", "delete_branch", "force_push", "generic_api_write", "generic_api_read", "manage_release"] as const) expect(evaluateAction(policy, "acme/web", a).allowed).toBe(true);
    expect(evaluateAction(presetPolicy("read_only"), "acme/web", "write_file").allowed).toBe(false);
    expect(evaluateAction(presetPolicy("read_only"), "acme/web", "generic_api_write").allowed).toBe(false);
  });
});

describe("presets", () => {
  it("read-only grants only reads; the PR workflow never grants a high or generic write action", async () => {
    const { ACTION_INFO, PRESET_INFO } = await import("../shared/actions");
    expect(PRESET_INFO.read_only.allow).toEqual(["read", "generic_api_read"]);
    for (const a of PRESET_INFO.pr_workflow.allow) expect(["safe", "low", "medium"]).toContain(ACTION_INFO[a].risk);
    expect(PRESET_INFO.pr_workflow.allow).not.toContain("generic_api_write");
    for (const a of ["merge", "write_file", "manage_release", "manage_actions", "manage_variables", "create_repo", "edit_repo", "manage_gists", "manage_project"] as const) expect(PRESET_INFO.pr_workflow.allow).not.toContain(a);
    expect(evaluateAction(presetPolicy("pr_workflow"), "acme/web", "create_branch").allowed).toBe(true);
    expect(evaluateAction(presetPolicy("pr_workflow"), "acme/web", "manage_release").message).toMatch(/Manage releases.*Do not retry/);
  });
});
