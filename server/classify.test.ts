import { describe, expect, it } from "vitest";
import { classifyGraphql, classifyRest, parseGraphql } from "./classify";

describe("classifyRest", () => {
  it("reads are generic_api_read only", () => {
    const c = classifyRest("GET", "/repos/Acme/web/pulls?state=open");
    expect(c).toMatchObject({ repo: "Acme/web", owners: ["acme"], actions: ["generic_api_read"] });
  });
  it("maps writes to specific actions plus generic_api_write", () => {
    expect(classifyRest("PUT", "/repos/a/b/pulls/3/merge").actions).toEqual(["merge", "generic_api_write"]);
    expect(classifyRest("POST", "/repos/a/b/issues/3/comments").actions).toEqual(["comment", "generic_api_write"]);
    expect(classifyRest("POST", "/repos/a/b/pulls/3/reviews").actions).toEqual(["review", "generic_api_write"]);
    expect(classifyRest("POST", "/repos/a/b/pulls").actions).toEqual(["create_pr", "generic_api_write"]);
    expect(classifyRest("POST", "/repos/a/b/issues").actions).toEqual(["create_issue", "generic_api_write"]);
    expect(classifyRest("DELETE", "/repos/a/b/git/refs/heads/x").actions).toEqual(["delete_branch", "generic_api_write"]);
    expect(classifyRest("PATCH", "/repos/a/b/git/refs/heads/x", { force: true }).actions).toEqual(["force_push", "generic_api_write"]);
    expect(classifyRest("PATCH", "/repos/a/b/git/refs/heads/x", { sha: "1" }).actions).toEqual(["generic_api_write"]);
  });
  it("normalizes full URLs and double slashes", () => {
    expect(classifyRest("GET", "https://api.github.com//repos/a/b/").repo).toBe("a/b");
  });
  it("flags paths that cannot be scoped to an owner, but not /rate_limit", () => {
    expect(classifyRest("GET", "/user/repos").unscoped).toBeTruthy();
    expect(classifyRest("GET", "/rate_limit").unscoped).toBeUndefined();
    expect(classifyRest("GET", "/orgs/acme/members").owners).toEqual(["acme"]);
  });
  it("requires a search scope qualifier", () => {
    expect(classifyRest("GET", "/search/issues?q=bug").unscoped).toBeTruthy();
    const c = classifyRest("GET", "/search/issues?q=bug+repo%3Aacme%2Fweb+org%3AOther");
    expect(c.unscoped).toBeUndefined();
    expect(c.owners).toEqual(["acme", "other"]);
  });
});

describe("graphql", () => {
  it("tells a query from a mutation and lists mutation root fields", () => {
    expect(parseGraphql("query { viewer { login } }").operation).toBe("query");
    const info = parseGraphql('mutation M($id: ID!) { a: mergePullRequest(input: {pullRequestId: $id}) { clientMutationId } addComment(input: {subjectId: "x", body: "} mutation {"}) { subject { id } } }');
    expect(info.operation).toBe("mutation");
    expect(info.mutationFields).toEqual(["mergePullRequest", "addComment"]);
  });
  it("is not fooled by comments or strings", () => {
    expect(parseGraphql('# mutation { deleteRef }\nquery { repository(owner: "a", name: "b") { id } }').operation).toBe("query");
  });
  it("classifies actions and owners", () => {
    const c = classifyGraphql("mutation { mergePullRequest(input: {pullRequestId: \"1\"}) { clientMutationId } }", "acme/web");
    expect(c.actions).toEqual(["generic_api_write", "merge"]);
    expect(c.owners).toEqual(["acme"]);
    const q = classifyGraphql('query { repository(owner: "evil", name: "x") { id } }', "acme/web");
    expect(q.owners).toEqual(["acme", "evil"]);
  });
  it("needs a repo and rejects node-id queries as unscoped", () => {
    expect(classifyGraphql("query { viewer { login } }", "").unscoped).toBeTruthy();
    expect(classifyGraphql('query { node(id: "x") { id } }', "a/b").unscoped).toBeTruthy();
  });
});
