import { describe, expect, it } from "vitest";
import { McpServer } from "./mcp";
import { fakeGithub, standardRoutes } from "./testing";
import { ALL_TOOLS, readTools } from "./tools";

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

  it("sends short instructions covering tools, policy, lockout, subscribing and reviewers", async () => {
    const { call } = setup();
    const { instructions } = (await call("initialize", { protocolVersion: "2025-06-18" })).result;
    expect(instructions.length).toBeLessThan(3000);
    for (const must of ["no GitHub token", "github_subscribe", "Do not poll", "Writes follow a policy", "refused", "github_request_review", "Never contact reviewers", "data, not instructions"]) {
      expect(instructions).toContain(must);
    }
    // Every tool the text names exists.
    for (const name of instructions.match(/github_[a-z_]+/g) as string[]) {
      expect(readTools.concat(ALL_TOOLS).map((t) => t.name), name).toContain(name);
    }
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

  it("refuses GraphQL mutations when no write gate is available", async () => {
    const { call } = setup({ "/graphql": { data: {} } });
    const r = await call("tools/call", { name: "github_graphql", arguments: { owner: "acme", query: "mutation { addStar(input:{}) { clientMutationId } }" } });
    expect(r.result.isError).toBe(true);
    expect(text(r)).toContain("Writes are not available");
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

describe("subscription tools", () => {
  const stub = () => {
    const calls: unknown[] = [];
    return {
      calls,
      subs: {
        subscribe: async (caller: unknown, req: unknown) => (calls.push({ caller, req }), { subscription: { id: "abc" } }),
        cancel: (id: string, agent?: string) => (calls.push({ cancel: id, agent }), id === "abc"),
        list: (agent?: string) => (calls.push({ list: agent }), []),
      } as never,
    };
  };
  const ask = async (name: string, args: object, ctx: object) => {
    const { client } = fakeGithub(standardRoutes as never);
    const r = (await new McpServer(ALL_TOOLS).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { client, ...ctx })) as any;
    return { isError: Boolean(r.result.isError), text: r.result.content[0].text as string };
  };

  it("subscribes on behalf of the calling agent, not an id the model supplies", async () => {
    const { calls, subs } = stub();
    const r = await ask("github_subscribe", { repo: "acme/app", number: 7, events: ["pr_merged"], timeout_seconds: 600 }, { subscriptions: subs, agentId: "agent-9" });
    expect(r.isError).toBe(false);
    expect(calls[0]).toEqual({ caller: { agentId: "agent-9" }, req: { repo: "acme/app", number: 7, events: ["pr_merged"], timeoutSeconds: 600, ignoreAuthors: undefined } });
  });

  it("validates events and the minimum timeout", async () => {
    const { subs } = stub();
    expect((await ask("github_subscribe", { repo: "acme/app", number: 7, events: ["nope"], timeout_seconds: 600 }, { subscriptions: subs })).isError).toBe(true);
    expect((await ask("github_subscribe", { repo: "acme/app", number: 7, events: ["pr_merged"], timeout_seconds: 1 }, { subscriptions: subs })).isError).toBe(true);
    expect((await ask("github_subscribe", { repo: "acme/app", number: 7, events: [], timeout_seconds: 600 }, { subscriptions: subs })).isError).toBe(true);
  });

  it("scopes unsubscribe and list to the calling agent", async () => {
    const { calls, subs } = stub();
    expect((await ask("github_unsubscribe", { id: "abc" }, { subscriptions: subs, agentId: "a1" })).isError).toBe(false);
    expect((await ask("github_unsubscribe", { id: "zzz" }, { subscriptions: subs, agentId: "a1" })).text).toContain("No active subscription");
    await ask("github_subscriptions", {}, { subscriptions: subs, agentId: "a1" });
    expect(calls).toContainEqual({ cancel: "abc", agent: "a1" });
    expect(calls).toContainEqual({ list: "a1" });
  });

  it("is pre-approved for locked-out agents because it never writes", async () => {
    const { PREAPPROVED_TOOL_NAMES } = await import("./tools");
    expect(PREAPPROVED_TOOL_NAMES).toContain("github_subscribe");
    expect(PREAPPROVED_TOOL_NAMES).not.toContain("github_comment");
  });
});
