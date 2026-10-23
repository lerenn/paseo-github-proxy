import { statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "./sessions";
import { tmp } from "./testing";

describe("SessionStore", () => {
  const file = () => path.join(tmp(), "s", "sessions.json");

  it("mints distinct capabilities, resolves them, and stores at mode 0600", () => {
    const f = file();
    const s = new SessionStore(f);
    const a = s.create("/a");
    const b = s.create("/b");
    expect(a).not.toBe(b);
    expect(s.resolve(a)?.cwd).toBe("/a");
    expect(s.resolve(b)?.cwd).toBe("/b");
    expect(s.resolve("nope")).toBeNull();
    expect(s.resolve(undefined)).toBeNull();
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it("survives a restart and forgets archived agents", () => {
    const f = file();
    const first = new SessionStore(f);
    const t = first.create("/a");
    expect(first.bind(t, "agent-1")).toBe(true);
    expect(first.bind("missing", "agent-2")).toBe(false);
    const second = new SessionStore(f);
    expect(second.resolve(t)).toMatchObject({ cwd: "/a", agentId: "agent-1" });
    second.forgetAgent("agent-1");
    expect(new SessionStore(f).resolve(t)).toBeNull();
  });
});
