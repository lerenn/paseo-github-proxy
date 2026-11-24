import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEntry } from "../shared/config";
import type { Parsed } from "./events";
import { signatureMatches, WebhookReceiver, WebhookServer } from "./webhook";

const app = (id: string, organization: string, isDefault = false): AppEntry => ({ id, organization, label: "", appId: id, installationId: "1", owners: [], default: isDefault });
const acme = app("acme", "acme");
const other = app("other", "other");
const sign = (secret: string, body: string | Buffer) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const prBody = (owner = "acme", extra: object = {}) => JSON.stringify({ action: "closed", repository: { full_name: `${owner}/web`, owner: { login: owner } }, pull_request: { number: 5, title: "T", merged: true, head: { sha: "abc1234" } }, sender: { login: "bob" }, ...extra });

function setup() {
  const events: Parsed[] = [];
  const receiver = new WebhookReceiver({
    secrets: () => [{ app: acme, secret: "s-acme" }, { app: other, secret: "s-other" }],
    apps: () => [acme, other],
    onEvent: (p) => void events.push(p),
    clock: () => 1000,
  });
  const post = (body: string | Buffer, headers: Record<string, string | undefined>, path = "/webhook", method = "POST") => receiver.handle({ method, path, headers, body: Buffer.from(body) });
  return { receiver, events, post };
}

describe("signature", () => {
  it("accepts only sha256=<hex of HMAC over the raw body>", () => {
    const body = Buffer.from("{}");
    expect(signatureMatches("k", body, sign("k", body))).toBe(true);
    expect(signatureMatches("k", body, sign("other", body))).toBe(false);
    expect(signatureMatches("k", body, undefined)).toBe(false);
    expect(signatureMatches("k", body, "sha256=zz")).toBe(false);
    expect(signatureMatches("k", body, sign("k", body).replace("sha256=", "sha1="))).toBe(false);
    expect(signatureMatches("k", body, sign("k", "{} "))).toBe(false);
  });
});

describe("WebhookReceiver", () => {
  it("rejects a missing or wrong signature with 401 and does nothing", async () => {
    const t = setup();
    const body = prBody();
    expect((await t.post(body, { "x-github-event": "pull_request" })).status).toBe(401);
    expect((await t.post(body, { "x-github-event": "pull_request", "x-hub-signature-256": sign("nope", body) })).status).toBe(401);
    expect(t.receiver.counters.badSignature).toBe(2);
    expect(t.events).toHaveLength(0);
  });

  it("accepts the signature of any App's secret and hands the event on", async () => {
    const t = setup();
    const body = prBody();
    const r = await t.post(body, { "x-github-event": "pull_request", "x-hub-signature-256": sign("s-acme", body), "x-github-delivery": "d1" });
    expect(r.status).toBe(200);
    expect(t.events).toHaveLength(1);
    expect(t.events[0]!.wake).toMatchObject({ kind: "pr_merged", repo: "acme/web", numbers: [5] });
    expect(t.receiver.counters.accepted).toBe(1);
  });

  it("refuses with 403 an owner the signing App does not serve, without saying why", async () => {
    const t = setup();
    const body = prBody("other"); // signed by acme's secret, but other/web belongs to the other App
    const r = await t.post(body, { "x-github-event": "pull_request", "x-hub-signature-256": sign("s-acme", body) });
    expect(r).toEqual({ status: 403, text: "forbidden" });
    expect(t.receiver.counters.badOwner).toBe(1);
    expect(t.events).toHaveLength(0);
    const ok = await t.post(body, { "x-github-event": "pull_request", "x-hub-signature-256": sign("s-other", body) });
    expect(ok.status).toBe(200);
  });

  it("drops a repeated delivery id", async () => {
    const t = setup();
    const body = prBody();
    const h = { "x-github-event": "pull_request", "x-hub-signature-256": sign("s-acme", body), "x-github-delivery": "same" };
    await t.post(body, h);
    const again = await t.post(body, h);
    expect(again.text).toBe("duplicate");
    expect(t.events).toHaveLength(1);
    expect(t.receiver.counters.duplicate).toBe(1);
  });

  it("answers ping and unknown events with 200 and does nothing", async () => {
    const t = setup();
    const ping = JSON.stringify({ zen: "x", hook_id: 1 });
    expect((await t.post(ping, { "x-github-event": "ping", "x-hub-signature-256": sign("s-acme", ping) })).status).toBe(200);
    const body = prBody();
    expect((await t.post(body, { "x-github-event": "star", "x-hub-signature-256": sign("s-acme", body) })).status).toBe(200);
    expect(t.events).toHaveLength(0);
    expect(t.receiver.counters.ignored).toBe(2);
  });

  it("classifies every delivery as delivered, ignored or rejected", async () => {
    let woken = 0;
    const receiver = new WebhookReceiver({ secrets: () => [{ app: acme, secret: "s-acme" }], apps: () => [acme, other], onEvent: () => woken, clock: () => 1000 });
    const post = (body: string, headers: Record<string, string>) => receiver.handle({ method: "POST", path: "/webhook", headers, body: Buffer.from(body) });
    const body = prBody();
    const ok = (id: string, event = "pull_request") => ({ "x-github-event": event, "x-github-delivery": id, "x-hub-signature-256": sign("s-acme", body) });
    woken = 2;
    await post(body, ok("1")); // woke two agents: one delivered event
    woken = 0;
    await post(body, ok("2")); // accepted, nobody subscribed: ignored
    await post(body, ok("3", "star")); // unused type: ignored
    const ping = JSON.stringify({ zen: "x" });
    await post(ping, { "x-github-event": "ping", "x-hub-signature-256": sign("s-acme", ping) }); // ignored
    await post(body, { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=" + "0".repeat(64) }); // bad signature
    const foreign = prBody("other");
    await post(foreign, { "x-github-event": "pull_request", "x-hub-signature-256": sign("s-acme", foreign) }); // wrong owner
    await post(body, ok("1")); // duplicate
    expect(receiver.events.stats()).toMatchObject({ received: 7, delivered: 1, ignored: 3, badSignature: 1, badOwner: 1, duplicate: 1 });
    expect(receiver.events.stats().series.at(-1)).toEqual({ delivered: 1, ignored: 3, rejected: 3 });
  });

  it("serves only POST /webhook and GET /healthz", async () => {
    const t = setup();
    expect((await t.post("", {}, "/healthz", "GET")).status).toBe(200);
    expect((await t.post("", {}, "/other")).status).toBe(404);
    expect((await t.post("", {}, "/webhook", "GET")).status).toBe(405);
    expect((await t.post("", {}, "/healthz", "POST")).status).toBe(404);
  });

  it("answers 400 for a signed body that is not JSON", async () => {
    const t = setup();
    expect((await t.post("nope", { "x-github-event": "push", "x-hub-signature-256": sign("s-acme", "nope") })).status).toBe(400);
  });

  it("with no App secret nothing is accepted", async () => {
    const receiver = new WebhookReceiver({ secrets: () => [], apps: () => [acme], onEvent: vi.fn() });
    const body = prBody();
    expect((await receiver.handle({ method: "POST", path: "/webhook", headers: { "x-hub-signature-256": sign("", body) }, body: Buffer.from(body) })).status).toBe(401);
  });
});

describe("WebhookServer (loopback)", () => {
  let server: WebhookServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it("is off until applied, enforces the body cap and serves the receiver", async () => {
    const t = setup();
    server = new WebhookServer(t.receiver, () => 2, undefined, 2048);
    expect(server.status()).toMatchObject({ enabled: false, listening: false });
    await server.apply({ enabled: true, port: 0, bind: "127.0.0.1" });
    const port = server.address();
    expect(port).toBeTruthy();
    expect(server.status().listening).toBe(true);
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const body = prBody();
    const ok = await fetch(`${base}/webhook`, { method: "POST", body, headers: { "x-github-event": "pull_request", "x-hub-signature-256": sign("s-acme", body) } });
    expect(ok.status).toBe(200);
    expect(t.events).toHaveLength(1);
    const huge = "x".repeat(5000);
    const big = await fetch(`${base}/webhook`, { method: "POST", body: huge, headers: { "x-hub-signature-256": sign("s-acme", huge) } }).catch(() => null);
    if (big) expect(big.status).toBe(413);
    expect(t.events).toHaveLength(1);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    await server.apply({ enabled: false, port: 0, bind: "127.0.0.1" });
    expect(server.status().listening).toBe(false);
  });

  it("reports a start error instead of throwing", async () => {
    const t = setup();
    server = new WebhookServer(t.receiver, () => 0, () => undefined);
    await server.apply({ enabled: true, port: 1, bind: "not-an-address.invalid" });
    expect(server.status()).toMatchObject({ listening: false });
    expect(server.status().error).not.toBe("");
  });
});
