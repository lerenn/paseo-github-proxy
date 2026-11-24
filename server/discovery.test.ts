import { describe, expect, it } from "vitest";
import { defaultConfig, presetPolicy, type AppEntry, type Config } from "../shared/config";
import { discoverOwners, discoverRepos, type LookupFn } from "./discovery";

const lookupOf = (routes: Record<string, unknown>): LookupFn => async (path, _query, via) => {
  const r = routes[via ? `${via.app}:${path}` : path] ?? routes[path];
  if (r instanceof Error) throw r;
  if (r === undefined) throw new Error(`404 ${path}`);
  return r;
};
const app = (id: string, owners: string[] = [], isDefault = false): AppEntry => ({ id, label: id, appId: id, installationId: "1", owners, default: isDefault });
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
    const r = await discoverOwners(lookupOf({ "/installation/repositories": { repositories: [{ owner: { login: "acme" } }, { owner: { login: "acme" } }] } }), "app", [app("a")]);
    expect(r.owners).toEqual(["acme"]);
  });
  it("asks every App and merges their owners; a failing App is reported without hiding the rest", async () => {
    const r = await discoverOwners(
      lookupOf({ "a:/installation/repositories": { repositories: [{ owner: { login: "acme" } }] }, "b:/installation/repositories": { repositories: [{ owner: { login: "Lerenn" } }] }, "c:/installation/repositories": new Error("bad key") }),
      "app",
      [app("a"), app("b"), app("c")],
    );
    expect(r).toEqual({ owners: ["acme", "lerenn"], error: "c: bad key" });
    expect((await discoverOwners(lookupOf({}), "app", [])).error).toMatch(/No GitHub App/);
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
    const r = await discoverRepos(lookupOf({ "/installation/repositories": { repositories: [{ full_name: "acme/a" }, { full_name: "other/b" }] } }), cfg({ allowedOwners: ["acme"], activeSource: "app" }), [], [app("a", [], true)]);
    expect(r.repos).toEqual(["acme/a"]);
  });
  it("reads each owner's repositories through the App that serves it", async () => {
    const routes = {
      "org:/installation/repositories": { repositories: [{ full_name: "acme/a" }, { full_name: "lerenn/leak" }] },
      "me:/installation/repositories": { repositories: [{ full_name: "lerenn/b" }] },
    };
    const apps = [app("org", ["acme"]), app("me", ["lerenn"])];
    const r = await discoverRepos(lookupOf(routes), cfg({ allowedOwners: ["acme", "lerenn"], activeSource: "app" }), [], apps);
    expect(r.repos).toEqual(["acme/a", "lerenn/b"]);
  });
  it("uses the default App for an owner no App claims, and reports an owner with no App", async () => {
    const routes = { "d:/installation/repositories": { repositories: [{ full_name: "zed/x" }] } };
    expect((await discoverRepos(lookupOf(routes), cfg({ allowedOwners: ["zed"], activeSource: "app" }), [], [app("d", [], true)])).repos).toEqual(["zed/x"]);
    const none = await discoverRepos(lookupOf(routes), cfg({ allowedOwners: ["zed"], activeSource: "app" }), [], [app("o", ["acme"])]);
    expect(none.errors[0]).toMatch(/^zed: no GitHub App/);
  });
  it("returns nothing when no owner is allowed", async () => {
    expect(await discoverRepos(lookupOf(routes), cfg({ allowedOwners: [] }), ["me"])).toEqual({ repos: [], errors: [] });
  });
});
