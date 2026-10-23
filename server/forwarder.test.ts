import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { connectWs, Forwarders, targetsOf, type Delivery } from "./forwarder";
import { dynamicGithub } from "./testing";

let wss: WebSocketServer;
let wsUrl: string;
let authHeader: string | undefined;
let serverSockets: WebSocket[] = [];
const acks: any[] = [];

beforeEach(async () => {
  acks.length = 0;
  serverSockets = [];
  authHeader = undefined;
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  wsUrl = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  wss.on("connection", (s, req) => {
    authHeader = req.headers.authorization;
    serverSockets.push(s);
    s.on("message", (m) => acks.push(JSON.parse(m.toString())));
  });
});
afterEach(async () => {
  for (const c of wss.clients) c.terminate();
  await new Promise((r) => wss.close(r));
});

const until = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function setup(hookHandler?: (method: string, path: string) => unknown, over: Record<string, unknown> = {}) {
  const hookCalls: string[] = [];
  const { client, tokens } = dynamicGithub((path, init) => {
    const method = init.method ?? "GET";
    hookCalls.push(`${method} ${path}`);
    const custom = hookHandler?.(method, path);
    if (custom !== undefined) return custom;
    if (method === "POST" && path === "/repos/acme/app/hooks") return { ws_url: wsUrl, url: "https://api.github.com/repos/acme/app/hooks/55" };
    if (path === "/repos/acme/app/hooks/55") return {};
    return undefined;
  });
  const deliveries: [string, Delivery][] = [];
  const states: number[] = [];
  const f = new Forwarders({ client, token: (o) => tokens.get(o), onDelivery: (r, d) => deliveries.push([r, d]), onState: () => states.push(Date.now()), retryBaseMs: 50, retryMaxMs: 200, unavailableMs: 60_000, ...over });
  return { f, hookCalls, deliveries };
}

const delivery = (event: string, payload: object) => JSON.stringify({ Header: { "X-Github-Event": [event] }, Body: Buffer.from(JSON.stringify(payload)).toString("base64") });

describe("Forwarders", () => {
  it("follows the gh webhook forward protocol: inactive hook, dial with the raw token, activate", async () => {
    const { f, hookCalls } = setup();
    f.ensure("Acme/App");
    await until(() => f.healthy("acme/app"));
    expect(authHeader).toBe("tok_acme");
    expect(hookCalls).toEqual(["POST /repos/acme/app/hooks", "PATCH /repos/acme/app/hooks/55"]);
    expect(f.views()).toEqual([{ repo: "acme/app", state: "healthy", detail: null }]);
    await f.stop();
  });

  it("decodes deliveries, acknowledges each one and hands it on", async () => {
    const { f, deliveries } = setup();
    f.ensure("acme/app");
    await until(() => f.healthy("acme/app"));
    serverSockets[0].send(delivery("pull_request_review", { action: "submitted", pull_request: { number: 7 } }));
    await until(() => deliveries.length === 1 && acks.length === 1);
    expect(deliveries[0]).toEqual(["acme/app", { event: "pull_request_review", payload: { action: "submitted", pull_request: { number: 7 } } }]);
    expect(acks[0]).toMatchObject({ Status: 200 });
    await f.stop();
  });

  it("survives garbage deliveries", async () => {
    const { f, deliveries } = setup();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    f.ensure("acme/app");
    await until(() => f.healthy("acme/app"));
    serverSockets[0].send("not json");
    serverSockets[0].send(delivery("issue_comment", { issue: { number: 7, pull_request: {} } }));
    await until(() => deliveries.length === 1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    await f.stop();
  });

  it("reconnects with a fresh hook after the socket drops", async () => {
    const { f, hookCalls } = setup();
    f.ensure("acme/app");
    await until(() => f.healthy("acme/app"));
    serverSockets[0].terminate();
    await until(() => f.views()[0].state === "connecting");
    await until(() => f.healthy("acme/app") && serverSockets.length === 2);
    expect(hookCalls.filter((c) => c.startsWith("POST")).length).toBe(2);
    expect(hookCalls).toContain("DELETE /repos/acme/app/hooks/55");
    await f.stop();
  });

  it("falls back to polling when GitHub refuses (no admin), and says why", async () => {
    const { f } = setup((method, path) => (method === "POST" && path.endsWith("/hooks") ? new Response('{"message":"Not Found"}', { status: 404 }) : undefined));
    f.ensure("acme/app");
    await until(() => f.views()[0]?.state === "unavailable");
    expect(f.views()[0].detail).toContain("admin");
    expect(f.healthy("acme/app")).toBe(false);
    await f.stop();
  });

  it("reports an existing forwarder (422) distinctly", async () => {
    const { f } = setup((method, path) => (method === "POST" && path.endsWith("/hooks") ? new Response('{"message":"Hook already exists"}', { status: 422 }) : undefined));
    f.ensure("acme/app");
    await until(() => f.views()[0]?.state === "unavailable");
    expect(f.views()[0].detail).toContain("already exists");
    await f.stop();
  });

  it("is unavailable without a token for the owner", async () => {
    const { f } = setup();
    f.ensure("stranger/app");
    await until(() => f.views()[0]?.state === "unavailable");
    expect(f.views()[0].detail).toContain("no token");
  });

  it("keeps one forwarder per repository and deletes the hook on release", async () => {
    const { f, hookCalls } = setup();
    f.ensure("acme/app");
    f.ensure("ACME/app");
    await until(() => f.healthy("acme/app"));
    expect(hookCalls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
    await f.release("acme/app");
    expect(hookCalls).toContain("DELETE /repos/acme/app/hooks/55");
    expect(f.views()).toEqual([]);
  });
});

describe("connectWs", () => {
  it("rejects when the server is unreachable", async () => {
    await expect(connectWs("ws://127.0.0.1:1", "t")).rejects.toThrow();
  });
});

describe("targetsOf", () => {
  it("extracts PR numbers and SHAs from the events we subscribe to", () => {
    expect(targetsOf({ event: "pull_request", payload: { number: 7 } })).toEqual({ numbers: [7], shas: [] });
    expect(targetsOf({ event: "pull_request_review", payload: { pull_request: { number: 8 } } }).numbers).toEqual([8]);
    expect(targetsOf({ event: "issue_comment", payload: { issue: { number: 9, pull_request: {} } } }).numbers).toEqual([9]);
    expect(targetsOf({ event: "issue_comment", payload: { issue: { number: 9 } } }).numbers).toEqual([]);
    expect(targetsOf({ event: "check_run", payload: { check_run: { head_sha: "abc", pull_requests: [{ number: 3 }] } } })).toEqual({ numbers: [3], shas: ["abc"] });
    expect(targetsOf({ event: "status", payload: { sha: "def" } })).toEqual({ numbers: [], shas: ["def"] });
    expect(targetsOf({ event: "workflow_run", payload: { workflow_run: { head_sha: "x", pull_requests: [] } } })).toEqual({ numbers: [], shas: ["x"] });
  });
});
