import path from "node:path";
import { statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { policySchema } from "../shared/policy";
import { AuditLog } from "./audit";
import { McpServer } from "./mcp";
import { fakeGithub, tmp } from "./testing";
import { ALL_TOOLS } from "./tools";
import { WriteGate } from "./write";

function setup(policy: object = {}, routes: Record<string, unknown> = {}) {
  const { client, calls } = fakeGithub({
    "/repos/acme/app/issues/7/comments": () => new Response('{"id":1}', { status: 201, headers: { "content-type": "application/json" } }),
    "/repos/acme/app/pulls": () => new Response('{"number":9}', { status: 201, headers: { "content-type": "application/json" } }),
    "/repos/acme/app/issues/7/labels": () => new Response('[{"name":"bug"}]', { status: 200, headers: { "content-type": "application/json" } }),
    "/repos/acme/app/issues/7/labels/old": () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    "/repos/acme/app/pulls/7/requested_reviewers": () => new Response("{}", { status: 201, headers: { "content-type": "application/json" } }),
    "/repos/acme/app/pulls/7/merge": () => new Response('{"merged":true}', { status: 200, headers: { "content-type": "application/json" } }),
    "/graphql": { data: { ok: true } },
    ...routes,
  } as never);
  const audit = new AuditLog(path.join(tmp(), "audit.jsonl"));
  const parsed = policySchema.parse(policy);
  const write = new WriteGate({ client, audit, policy: async () => parsed });
  const mcp = new McpServer(ALL_TOOLS);
  const call = async (name: string, args: object) => {
    const r = (await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { client, write, agentId: "agent-1" })) as any;
    return { isError: Boolean(r.result.isError), text: r.result.content[0].text as string };
  };
  const sent = () => calls.filter((c) => c.init.method && c.init.method !== "GET");
  return { call, audit, calls, sent, write };
}

describe("write tools", () => {
  it("comments, opens PRs, labels and requests reviews by default, with audit entries", async () => {
    const { call, audit, sent } = setup();
    expect((await call("github_comment", { repo: "acme/app", number: 7, body: "hello" })).isError).toBe(false);
    expect((await call("github_pr_create", { repo: "acme/app", title: "T", head: "feat", base: "main" })).isError).toBe(false);
    expect((await call("github_label", { repo: "acme/app", number: 7, add: ["bug"], remove: ["old"] })).isError).toBe(false);
    expect((await call("github_request_review", { repo: "acme/app", pr: 7, reviewers: ["bob"] })).isError).toBe(false);
    expect(sent().map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "POST /repos/acme/app/issues/7/comments",
      "POST /repos/acme/app/pulls",
      "POST /repos/acme/app/issues/7/labels",
      "DELETE /repos/acme/app/issues/7/labels/old",
      "POST /repos/acme/app/pulls/7/requested_reviewers",
    ]);
    const entries = audit.recent();
    expect(entries).toHaveLength(5);
    expect(entries.every((e) => e.decision === "allowed" && e.agentId === "agent-1")).toBe(true);
    expect(entries.find((e) => e.summary.startsWith("comment"))).toMatchObject({ repo: "acme/app", ops: ["comment"], status: 201 });
  });

  it("never sends a refused merge and audits it", async () => {
    const { call, audit, sent } = setup();
    const r = await call("github_pr_merge", { repo: "acme/app", pr: 7 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("pr.merge");
    expect(r.text).toContain("Nothing was sent to GitHub");
    expect(sent()).toHaveLength(0);
    expect(audit.recent()[0]).toMatchObject({ decision: "refused", ops: ["pr.merge"], repo: "acme/app", status: null });
  });

  it("refuses the same merge through the generic write tool", async () => {
    const { call, sent } = setup();
    expect((await call("github_write", { method: "PUT", path: "/repos/acme/app/pulls/7/merge" })).isError).toBe(true);
    expect((await call("github_write", { method: "PUT", path: "/repos/acme/app/pulls/7/merge?x=1" })).isError).toBe(true);
    expect((await call("github_write", { method: "PUT", path: "/repos/ACME/App/pulls/7/merge/" })).isError).toBe(true);
    expect(sent()).toHaveLength(0);
  });

  it("refuses admin calls by default", async () => {
    const { call, sent } = setup();
    const r = await call("github_write", { method: "POST", path: "/repos/acme/app/hooks", body: { url: "https://evil" } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("admin");
    expect(sent()).toHaveLength(0);
  });

  it("allows a merge only where the policy says so", async () => {
    const { call, sent } = setup({ repos: [{ repo: "acme/*", allow: ["pr.merge"] }, { repo: "acme/tf-aws", deny: ["pr.merge"] }] });
    expect((await call("github_pr_merge", { repo: "acme/app", pr: 7 })).isError).toBe(false);
    expect(sent()).toHaveLength(1);
    const denied = await call("github_pr_merge", { repo: "acme/tf-aws", pr: 7 });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("acme/tf-aws");
    expect(sent()).toHaveLength(1);
  });

  it("audits GitHub failures of allowed writes with the status", async () => {
    const { call, audit } = setup({}, { "/repos/acme/app/issues/7/comments": () => new Response('{"message":"Validation Failed"}', { status: 422 }) });
    const r = await call("github_comment", { repo: "acme/app", number: 7, body: "x" });
    expect(r.isError).toBe(true);
    expect(audit.recent()[0]).toMatchObject({ decision: "allowed", status: 422 });
  });

  it("does not log request bodies", async () => {
    const { call, audit } = setup();
    await call("github_comment", { repo: "acme/app", number: 7, body: "super secret text" });
    expect(JSON.stringify(audit.recent())).not.toContain("super secret");
  });

  it("routes GraphQL mutations through the policy", async () => {
    const { call, sent } = setup();
    const merge = await call("github_graphql", { owner: "acme", query: "mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"x\"}) { clientMutationId } }" });
    expect(merge.isError).toBe(true);
    expect(merge.text).toContain("pr.merge");
    const hidden = await call("github_graphql", { owner: "acme", query: "query { viewer { id } } mutation { mergePullRequest(input: {}) { clientMutationId } }" });
    expect(hidden.isError).toBe(true);
    const comment = await call("github_graphql", { owner: "acme", query: "mutation { addComment(input: {subjectId: \"x\", body: \"hi\"}) { clientMutationId } }" });
    expect(comment.isError).toBe(false);
    expect(sent()).toHaveLength(1);
  });

  it("a per-repo deny also blocks GraphQL merges, because the repository is unknown there", async () => {
    const { call, sent } = setup({ repos: [{ repo: "*", allow: ["pr.merge"] }, { repo: "acme/tf-aws", deny: ["pr.merge"] }] });
    const r = await call("github_graphql", { owner: "acme", query: "mutation { mergePullRequest(input: {}) { clientMutationId } }" });
    expect(r.isError).toBe(true);
    expect(sent()).toHaveLength(0);
  });

  it("refuses writes when there is no gate (gh shim context)", async () => {
    const { client } = fakeGithub({});
    const r = (await new McpServer(ALL_TOOLS).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "github_comment", arguments: { repo: "acme/app", number: 1, body: "x" } } }, { client })) as any;
    expect(r.result.isError).toBe(true);
  });

  it("stores the audit log at mode 0600 and survives garbage lines", async () => {
    const { call, audit } = setup();
    await call("github_pr_merge", { repo: "acme/app", pr: 7 });
    const file = (audit as unknown as { file: string }).file;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(audit.recent(10)).toHaveLength(1);
  });
});
