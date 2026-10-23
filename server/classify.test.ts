import { describe, expect, it } from "vitest";
import { classifyGraphql, classifyRest, graphqlMutationFields } from "./classify";

const c = (method: string, path: string, body?: unknown) => classifyRest(method, path, body);

describe("classifyRest", () => {
  it("recognizes the default-allowed writes", () => {
    expect(c("POST", "/repos/Acme/App/issues/7/comments")).toEqual({ repo: "acme/app", ops: ["comment"] });
    expect(c("POST", "/repos/acme/app/pulls")).toEqual({ repo: "acme/app", ops: ["pr.create"] });
    expect(c("POST", "/repos/acme/app/issues/7/labels", { labels: ["x"] }).ops).toEqual(["label"]);
    expect(c("DELETE", "/repos/acme/app/issues/7/labels/bug").ops).toEqual(["label"]);
    expect(c("POST", "/repos/acme/app/pulls/7/requested_reviewers").ops).toEqual(["review.request"]);
    expect(c("POST", "/repos/acme/app/pulls/7/comments").ops).toEqual(["comment"]);
  });

  it("ignores query strings and trailing slashes", () => {
    expect(c("POST", "/repos/acme/app/pulls/?x=1").ops).toEqual(["pr.create"]);
  });

  it("classifies merges", () => {
    expect(c("PUT", "/repos/acme/app/pulls/7/merge").ops).toEqual(["pr.merge"]);
  });

  it("splits PR edits into close and update", () => {
    expect(c("PATCH", "/repos/acme/app/pulls/7", { state: "closed" }).ops).toEqual(["pr.close"]);
    expect(c("PATCH", "/repos/acme/app/pulls/7", { title: "x" }).ops).toEqual(["pr.update"]);
    expect(c("PATCH", "/repos/acme/app/pulls/7", { state: "closed", title: "x" }).ops.sort()).toEqual(["pr.close", "pr.update"]);
  });

  it("does not let the issues endpoint bypass the pull request operations", () => {
    expect(c("PATCH", "/repos/acme/app/issues/7", { state: "closed" }).ops.sort()).toEqual(["issue.update", "pr.close"]);
    expect(c("PATCH", "/repos/acme/app/issues/7", { title: "x" }).ops.sort()).toEqual(["issue.update", "pr.update"]);
    expect(c("PATCH", "/repos/acme/app/issues/7", { labels: ["a"] }).ops.sort()).toEqual(["issue.update", "label"]);
  });

  it("requires label permission when creating an issue with labels", () => {
    expect(c("POST", "/repos/acme/app/issues", { title: "t", labels: ["a"] }).ops.sort()).toEqual(["issue.create", "label"]);
    expect(c("POST", "/repos/acme/app/issues", { title: "t" }).ops).toEqual(["issue.create"]);
  });

  it("treats approvals and change requests as review.submit, plain review comments as comments", () => {
    expect(c("POST", "/repos/acme/app/pulls/7/reviews", { event: "APPROVE" }).ops).toEqual(["review.submit"]);
    expect(c("POST", "/repos/acme/app/pulls/7/reviews", { event: "request_changes" }).ops).toEqual(["review.submit"]);
    expect(c("POST", "/repos/acme/app/pulls/7/reviews", { event: "COMMENT" }).ops).toEqual(["comment"]);
    expect(c("POST", "/repos/acme/app/pulls/7/reviews/3/events").ops).toEqual(["review.submit"]);
  });

  it("classifies admin surfaces", () => {
    for (const [m, p] of [
      ["POST", "/repos/acme/app/hooks"], ["PUT", "/repos/acme/app/collaborators/bob"], ["PUT", "/repos/acme/app/branches/main/protection"],
      ["PUT", "/repos/acme/app/actions/secrets/X"], ["DELETE", "/repos/acme/app"], ["PATCH", "/repos/acme/app"], ["POST", "/repos/acme/app/rulesets"],
      ["POST", "/repos/acme/app/transfer"], ["POST", "/orgs/acme/teams"], ["PUT", "/user/starred/x"],
    ]) {
      expect(c(m, p).ops, `${m} ${p}`).toEqual(["admin"]);
    }
  });

  it("classifies deletions and unknown writes", () => {
    expect(c("DELETE", "/repos/acme/app/git/refs/heads/x").ops).toEqual(["branch.delete"]);
    expect(c("DELETE", "/repos/acme/app/issues/comments/9").ops).toEqual(["comment.delete"]);
    expect(c("POST", "/repos/acme/app/releases").ops).toEqual(["other"]);
    expect(c("POST", "/gists")).toEqual({ repo: null, ops: ["other"] });
  });
});

describe("GraphQL mutations", () => {
  it("finds root fields, with aliases, arguments and nested selections", () => {
    expect(graphqlMutationFields('mutation Merge($id: ID!) { a: mergePullRequest(input: {pullRequestId: $id, commitBody: "x { y }"}) { pullRequest { id } } addComment(input: {}) { clientMutationId } }')).toEqual(["mergePullRequest", "addComment"]);
  });

  it("returns null for queries and ignores the word mutation in comments and strings", () => {
    expect(graphqlMutationFields("{ viewer { login } }")).toBeNull();
    expect(graphqlMutationFields("# mutation\nquery { a }")).toBeNull();
    expect(graphqlMutationFields('query { search(query: "mutation { x }") { issueCount } }')).toBeNull();
  });

  it("finds mutations after a query in the same document", () => {
    expect(graphqlMutationFields("query A { viewer { id } } mutation B { closePullRequest(input: {}) { clientMutationId } }")).toEqual(["closePullRequest"]);
  });

  it("maps fields to operations and refuses unknown ones", () => {
    expect(classifyGraphql(["addComment", "enablePullRequestAutoMerge"]).sort()).toEqual(["comment", "pr.merge"]);
    expect(classifyGraphql(["deleteRepository"])).toEqual(["other"]);
    expect(classifyGraphql([])).toEqual(["other"]);
  });
});
