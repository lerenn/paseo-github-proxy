import { describe, expect, it } from "vitest";
import { defaultConfig, presetPolicy, type Config } from "../shared/config";
import { discoverOwners, discoverRepos, type LookupFn } from "./discovery";

const lookupOf = (routes: Record<string, unknown>): LookupFn => async (path) => {
  const r = routes[path];
  if (r instanceof Error) throw r;
  if (r === undefined) throw new Error(`404 ${path}`);
  return r;
};
const cfg = (patch: Partial<Config>): Config => ({ ...defaultConfig(), ...patch });

describe("discoverOwners", () => {
  it("lists the gh user and orgs, sorted and lower-cased", async () => {
    const r = await discoverOwners(lookupOf({ "/user": { login: "Lerenn" }, "/user/orgs": [{ login: "Acme" }] }), "gh");
    expect(r).toEqual({ owners: ["acme", "lerenn"], error: "" });
  });
  it("keeps the user when the org list fails", async () => {
    expect((await discoverOwners(lookupOf({ "/user": { login: "me" } }), "gh")).owners).toEqual(["me"]);
  });
  it("lists installation owners for an App", async () => {
    const r = await discoverOwners(lookupOf({ "/installation/repositories": { repositories: [{ owner: { login: "acme" } }, { owner: { login: "acme" } }] } }), "app");
    expect(r.owners).toEqual(["acme"]);
  });
  it("degrades to an error message", async () => {
    const r = await discoverOwners(lookupOf({ "/user": new Error("not logged in") }), "gh");
    expect(r).toEqual({ owners: [], error: "not logged in" });
  });
});

describe("discoverRepos", () => {
  const routes = { "/orgs/acme/repos": [{ full_name: "acme/web" }, { full_name: "acme/secret" }], "/users/me/repos": [{ full_name: "me/dotfiles" }] };
  it("lists repos of allowed owners, falling back to /users, and hides repos the policy denies reading", async () => {
    const policy = { ...presetPolicy("read_only"), rules: [{ id: "r", effect: "deny" as const, repos: ["acme/secret"], actions: ["read" as const], reason: "" }] };
    const r = await discoverRepos(lookupOf(routes), cfg({ allowedOwners: ["acme", "me"], policy }), []);
    expect(r.repos).toEqual(["acme/web", "me/dotfiles"]);
  });
  it("uses discovered owners when * is allowed", async () => {
    const r = await discoverRepos(lookupOf(routes), cfg({ allowedOwners: ["*"] }), ["me"]);
    expect(r.repos).toEqual(["me/dotfiles"]);
  });
  it("reports a failing owner and keeps going", async () => {
    const r = await discoverRepos(lookupOf(routes), cfg({ allowedOwners: ["ghost", "me"] }), []);
    expect(r.repos).toEqual(["me/dotfiles"]);
    expect(r.errors[0]).toMatch(/^ghost:/);
  });
  it("filters installation repos by owner for an App", async () => {
    const r = await discoverRepos(lookupOf({ "/installation/repositories": { repositories: [{ full_name: "acme/a" }, { full_name: "other/b" }] } }), cfg({ allowedOwners: ["acme"], activeSource: "app" }), []);
    expect(r.repos).toEqual(["acme/a"]);
  });
  it("returns nothing when no owner is allowed", async () => {
    expect(await discoverRepos(lookupOf(routes), cfg({ allowedOwners: [] }), ["me"])).toEqual({ repos: [], errors: [] });
  });
});
