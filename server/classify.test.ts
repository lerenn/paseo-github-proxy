import { describe, expect, it } from "vitest";
import { classifyGraphql, classifyRest, parseGraphql } from "./classify";

describe("classifyRest", () => {
  it("reads are generic_api_read only", () => {
    const c = classifyRest("GET", "/repos/Acme/web/pulls", undefined, "state=open");
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
  it("maps the parity writes to their specific actions", () => {
    const w = (m: string, path: string, body?: unknown) => classifyRest(m, path, body).actions;
    expect(w("POST", "/repos/a/b/git/refs")).toEqual(["create_branch", "generic_api_write"]);
    expect(w("PUT", "/repos/a/b/contents/x/y.md")).toEqual(["write_file", "generic_api_write"]);
    expect(w("DELETE", "/repos/a/b/contents/x.md")).toEqual(["write_file", "generic_api_write"]);
    expect(w("POST", "/repos/a/b/labels")).toEqual(["manage_labels", "generic_api_write"]);
    expect(w("DELETE", "/repos/a/b/labels/bug")).toEqual(["manage_labels", "generic_api_write"]);
    expect(w("POST", "/repos/a/b/releases")).toEqual(["manage_release", "generic_api_write"]);
    expect(w("DELETE", "/repos/a/b/releases/assets/3")).toEqual(["manage_release", "generic_api_write"]);
    expect(w("POST", "/repos/a/b/actions/runs/3/rerun")).toEqual(["manage_actions", "generic_api_write"]);
    expect(w("POST", "/repos/a/b/actions/workflows/ci.yml/dispatches")).toEqual(["manage_actions", "generic_api_write"]);
    expect(w("DELETE", "/repos/a/b/actions/caches/3")).toEqual(["manage_actions", "generic_api_write"]);
    expect(w("POST", "/repos/a/b/actions/variables")).toEqual(["manage_variables", "generic_api_write"]);
    expect(w("DELETE", "/repos/a/b/actions/secrets/X")).toEqual(["manage_variables", "generic_api_write"]);
    expect(w("PATCH", "/repos/a/b/environments/prod/variables/X")).toEqual(["manage_variables", "generic_api_write"]);
    expect(w("PATCH", "/repos/a/b")).toEqual(["edit_repo", "generic_api_write"]);
    expect(w("PUT", "/repos/a/b/topics")).toEqual(["edit_repo", "generic_api_write"]);
    expect(w("POST", "/repos/a/b/forks")).toEqual(["create_repo", "generic_api_write"]);
    expect(w("POST", "/repos/a/b/merge-upstream")).toEqual(["merge", "generic_api_write"]);
    expect(w("POST", "/repos/a/b/issues/3/labels")).toEqual(["update_pr", "generic_api_write"]);
    expect(w("DELETE", "/repos/a/b/issues/3/assignees")).toEqual(["update_pr", "generic_api_write"]);
    expect(w("PUT", "/repos/a/b/issues/3/lock")).toEqual(["update_pr", "generic_api_write"]);
    expect(w("POST", "/repos/a/b/pulls/3/requested_reviewers")).toEqual(["update_pr", "generic_api_write"]);
    expect(w("PUT", "/repos/a/b/pulls/3/update-branch")).toEqual(["update_pr", "generic_api_write"]);
    expect(w("PATCH", "/repos/a/b/issues/comments/3")).toEqual(["update_pr", "generic_api_write"]);
    expect(w("POST", "/repos/a/b/pulls/3/comments/9/replies")).toEqual(["comment", "generic_api_write"]);
    expect(w("PUT", "/repos/a/b/notifications")).toEqual(["manage_notifications", "generic_api_write"]);
    expect(w("POST", "/orgs/acme/repos")).toEqual(["create_repo", "generic_api_write"]);
    expect(w("PUT", "/orgs/acme/actions/variables/X")).toEqual(["manage_variables", "generic_api_write"]);
    expect(w("POST", "/user/repos")).toEqual(["create_repo", "generic_api_write"]);
    expect(w("POST", "/gists")).toEqual(["manage_gists", "generic_api_write"]);
    expect(w("PATCH", "/notifications/threads/3")).toEqual(["manage_notifications", "generic_api_write"]);
    expect(w("GET", "/repos/a/b/releases")).toEqual(["generic_api_read"]);
    expect(classifyRest("POST", "/gists").unscoped).toBeTruthy();
  });
  it("refuses full URLs, double slashes and trailing slashes instead of normalizing them", () => {
    for (const p of ["https://api.github.com/repos/a/b", "//repos/a/b", "/repos//a/b", "/repos/a/b/", "repos/a/b"]) expect(() => classifyRest("GET", p), p).toThrow(/Do not retry/);
  });
  it("flags paths that cannot be scoped to an owner, but not /rate_limit", () => {
    expect(classifyRest("GET", "/user/repos").unscoped).toBeTruthy();
    expect(classifyRest("GET", "/rate_limit").unscoped).toBeUndefined();
    expect(classifyRest("GET", "/orgs/acme/members").owners).toEqual(["acme"]);
  });
  it("requires a search scope qualifier", () => {
    expect(classifyRest("GET", "/search/issues", undefined, "q=bug").unscoped).toBeTruthy();
    const c = classifyRest("GET", "/search/issues", undefined, "q=bug+repo%3Aacme%2Fweb+org%3AOther");
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
  it("maps the parity mutations", () => {
    const m = (field: string) => classifyGraphql(`mutation { ${field}(input: {}) { clientMutationId } }`, "acme/web").actions;
    expect(m("markPullRequestReadyForReview")).toEqual(["generic_api_write", "update_pr"]);
    expect(m("convertPullRequestToDraft")).toEqual(["generic_api_write", "update_pr"]);
    expect(m("disablePullRequestAutoMerge")).toEqual(["generic_api_write", "merge"]);
    expect(m("resolveReviewThread")).toEqual(["generic_api_write", "review"]);
    expect(m("createRef")).toEqual(["generic_api_write", "create_branch"]);
    expect(m("addProjectV2ItemById")).toEqual(["generic_api_write", "manage_project"]);
    expect(m("updateProjectV2ItemFieldValue")).toEqual(["generic_api_write", "manage_project"]);
  });
  it("needs a repo and rejects node-id queries as unscoped", () => {
    expect(classifyGraphql("query { viewer { login } }", "").unscoped).toBeTruthy();
    expect(classifyGraphql('query { node(id: "x") { id } }', "a/b").unscoped).toBeTruthy();
  });
});
