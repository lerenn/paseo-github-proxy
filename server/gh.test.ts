import { describe, expect, it } from "vitest";
import { runGh } from "./gh";
import { fakeGithub, PR, standardRoutes } from "./testing";

const gh = (argv: string[], routes: Record<string, unknown> = standardRoutes) => {
  const { client, calls } = fakeGithub(routes as never);
  return { run: () => runGh(argv, { client }), calls };
};

describe("gh shim", () => {
  it("pr view -R --json returns gh-shaped fields", async () => {
    const out = await gh(["pr", "view", "7", "-R", "acme/app", "--json", "number,state,author,headRefName,labels,reviewRequests"]).run();
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      number: 7, state: "OPEN", author: { login: "ada", id: "U1", type: "User" }, headRefName: "feat",
      labels: [{ name: "bug", color: "f00", description: null }], reviewRequests: [{ login: "bob", id: "U2", type: undefined }],
    });
  });

  it("pr view prints key/value text without --json", async () => {
    const out = await gh(["pr", "view", "7", "-R", "acme/app"]).run();
    expect(out.stdout).toContain("title:\tAdd thing");
    expect(out.stdout).toContain("state:\tOPEN");
    expect(out.stdout).toContain("--\nBody text");
  });

  it("reports MERGED for merged PRs", async () => {
    const out = await gh(["pr", "view", "7", "-R", "acme/app", "--json", "state"], { "/repos/acme/app/pulls/7": { ...PR, state: "closed", merged_at: "2026-01-03T00:00:00Z" } }).run();
    expect(JSON.parse(out.stdout)).toEqual({ state: "MERGED" });
  });

  it("rejects unknown --json fields and lists the valid ones", async () => {
    const out = await gh(["pr", "view", "7", "-R", "acme/app", "--json", "nope"]).run();
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('Unknown JSON field: "nope"');
    expect(out.stderr).toContain("statusCheckRollup");
  });

  it("pr checks: exit 8 while pending, 1 on failure, bucketed output", async () => {
    const pending = await gh(["pr", "checks", "7", "-R", "acme/app"], { ...standardRoutes, "/repos/acme/app/commits/abc123/status": { statuses: [] } }).run();
    expect(pending.code).toBe(8);
    expect(pending.stdout).toContain("ci\tpass\t1m5s\thttps://x/ci");
    expect(pending.stdout).toContain("lint\tpending");
    const failed = await gh(["pr", "checks", "7", "-R", "acme/app", "--json", "name,bucket"]).run();
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout)).toContainEqual({ name: "legacy", bucket: "fail" });
  });

  it("pr diff asks for the diff media type", async () => {
    const g = gh(["pr", "diff", "7", "-R", "acme/app"], { ...standardRoutes, "/repos/acme/app/pulls/7": (init: RequestInit) => new Response((init.headers as Record<string, string>).accept.includes("diff") ? "diff --git a b" : JSON.stringify(PR)) });
    const out = await g.run();
    expect(out).toMatchObject({ code: 0, stdout: "diff --git a b" });
  });

  it("finds the PR for a branch", async () => {
    const out = await gh(["pr", "view", "feat", "-R", "acme/app", "--json", "number"]).run();
    expect(JSON.parse(out.stdout)).toEqual({ number: 7 });
  });

  it("api GETs with {owner}/{repo} placeholders and returns the raw JSON", async () => {
    const out = await gh(["api", "repos/{owner}/{repo}/pulls/7", "-R", "acme/app", "--jq", ".title"]).run();
    expect(out.jq).toBe(".title");
    expect(JSON.parse(out.stdout).title).toBe("Add thing");
  });

  it("api turns -f fields into a query string for GET", async () => {
    const g = gh(["api", "/repos/acme/app/pulls", "-X", "GET", "-f", "state=closed"], { "/repos/acme/app/pulls?state=closed": [] });
    expect((await g.run()).stdout.trim()).toBe("[]");
  });

  it("api --paginate flattens pages", async () => {
    const out = await gh(["api", "/repos/acme/app/pulls", "--paginate"], {
      "/repos/acme/app/pulls": [1],
    }).run();
    expect(JSON.parse(out.stdout)).toEqual([1]);
  });

  it("api graphql runs queries and refuses mutations", async () => {
    const routes = { "/graphql": { data: { repository: { id: "R" } } } };
    const q = await gh(["api", "graphql", "-F", "owner=acme", "-f", "query=query($owner:String!){repository(owner:$owner){id}}"], routes).run();
    expect(JSON.parse(q.stdout)).toEqual({ data: { repository: { id: "R" } } });
    const m = await gh(["api", "graphql", "-F", "owner=acme", "-f", "query=mutation { x }"], routes).run();
    expect(m.code).toBe(1);
    expect(m.stderr).toContain("mutations");
  });

  it("refuses writes with a pointer to the MCP tools", async () => {
    for (const argv of [["api", "-X", "POST", "/repos/acme/app/issues"], ["pr", "merge", "7"], ["pr", "comment", "7", "-b", "hi"], ["api", "/repos/acme/app/issues", "-f", "title=x"]]) {
      const out = await gh(argv).run();
      expect(out.code).toBe(1);
      expect(out.stderr).toMatch(/Writes are not available/);
    }
  });

  it("explains unsupported commands", async () => {
    const out = await gh(["gist", "list"]).run();
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("not supported");
  });

  it("surfaces GitHub errors", async () => {
    const out = await gh(["pr", "view", "99", "-R", "acme/app"]).run();
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("404");
  });

  it("explains a missing token", async () => {
    const out = await gh(["pr", "view", "1", "-R", "stranger/app"]).run();
    expect(out.stderr).toContain("No GitHub token for stranger");
  });
});
