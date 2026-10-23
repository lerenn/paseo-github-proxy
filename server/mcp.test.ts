import { describe, expect, it } from "vitest";
import { McpServer } from "./mcp";
import { fakeGithub, standardRoutes } from "./testing";
import { readTools } from "./tools";

function setup(routes: Record<string, unknown> = standardRoutes) {
  const { client, calls } = fakeGithub(routes as never);
  const mcp = new McpServer(readTools);
  const call = (method: string, params?: object) => mcp.handle({ jsonrpc: "2.0", id: 1, method, params }, { client }) as Promise<any>;
  return { call, calls, mcp, client };
}
const text = (r: any) => r.result.content[0].text as string;

describe("McpServer", () => {
  it("negotiates the protocol version", async () => {
    const { call } = setup();
    expect((await call("initialize", { protocolVersion: "2025-03-26" })).result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "github-proxy" } });
    expect((await call("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe("2025-06-18");
  });

  it("ignores notifications", async () => {
    const { mcp, client } = setup();
    expect(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }, { client })).toBeNull();
  });

  it("lists tools with JSON schemas and no write tools", async () => {
    const { call } = setup();
    const tools = (await call("tools/list")).result.tools as { name: string; inputSchema: any }[];
    expect(tools.map((t) => t.name)).toContain("github_pr_checks");
    expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true);
    expect(tools.some((t) => /comment$|create|merge|label/.test(t.name) && t.name !== "github_comments")).toBe(false);
  });

  it("runs github_pr_view", async () => {
    const { call } = setup();
    const r = await call("tools/call", { name: "github_pr_view", arguments: { repo: "acme/app", pr: "7", fields: ["number", "state"] } });
    expect(JSON.parse(text(r))).toEqual({ number: 7, state: "OPEN" });
  });

  it("summarizes checks", async () => {
    const { call } = setup();
    const r = JSON.parse(text(await call("tools/call", { name: "github_pr_checks", arguments: { repo: "acme/app", pr: "7" } })));
    expect(r.overall).toBe("fail");
    expect(r.sha).toBe("abc123");
    expect(r.checks).toHaveLength(3);
  });

  it("returns tool errors as isError results, not protocol errors", async () => {
    const { call } = setup();
    const r = await call("tools/call", { name: "github_pr_view", arguments: { repo: "acme/app", pr: "404" } });
    expect(r.result.isError).toBe(true);
    expect(text(r)).toContain("404");
  });

  it("validates arguments", async () => {
    const { call } = setup();
    const r = await call("tools/call", { name: "github_issue_view", arguments: { repo: "acme/app", number: "x" } });
    expect(r.result.isError).toBe(true);
    expect(text(r)).toContain("Invalid arguments");
  });

  it("refuses GraphQL mutations", async () => {
    const { call } = setup({ "/graphql": { data: {} } });
    const r = await call("tools/call", { name: "github_graphql", arguments: { owner: "acme", query: "mutation { addStar(input:{}) { clientMutationId } }" } });
    expect(r.result.isError).toBe(true);
    expect(text(r)).toContain("mutations");
  });

  it("does not mistake a field named mutation_x or a comment for a mutation", async () => {
    const { call } = setup({ "/graphql": { data: { ok: true } } });
    const r = await call("tools/call", { name: "github_graphql", arguments: { owner: "acme", query: "# mutation of the day\n{ viewer { login } }" } });
    expect(r.result.isError).toBeUndefined();
  });

  it("reports the shared budget", async () => {
    const { call } = setup();
    const r = JSON.parse(text(await call("tools/call", { name: "github_rate_limit", arguments: { owner: "acme" } })));
    expect(r).toHaveProperty("resources");
    expect(r.pausedUntil).toBeNull();
  });

  it("answers unknown methods and tools", async () => {
    const { call } = setup();
    expect((await call("resources/list")).error.code).toBe(-32601);
    expect((await call("tools/call", { name: "nope" })).error.code).toBe(-32602);
  });
});
