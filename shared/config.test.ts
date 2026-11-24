import { describe, expect, it } from "vitest";
import { configSchema, defaultConfig, webhookListenerUrl } from "./config";

describe("webhook bind", () => {
  it("binds every interface on a fresh config", () => {
    expect(defaultConfig().webhooks).toEqual({ enabled: false, port: 8787, bind: "0.0.0.0" });
    expect(configSchema.parse({ webhooks: { enabled: true } }).webhooks.bind).toBe("0.0.0.0");
  });

  it("respects an explicit bind", () => {
    expect(configSchema.parse({ webhooks: { bind: "127.0.0.1" } }).webhooks.bind).toBe("127.0.0.1");
  });

  it("shows a usable listener URL", () => {
    expect(webhookListenerUrl("0.0.0.0", 8787, "/webhook")).toBe("http://<this machine>:8787/webhook");
    expect(webhookListenerUrl("127.0.0.1", 9000, "/webhook")).toBe("http://127.0.0.1:9000/webhook");
  });
});
