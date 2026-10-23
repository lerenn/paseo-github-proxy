import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeOwner, scrub, TokenStore, tokenKey } from "./tokens";

function store() {
  const dir = mkdtempSync(path.join(tmpdir(), "ghp-"));
  return { file: path.join(dir, "sub", "tokens.json"), store: new TokenStore(path.join(dir, "sub", "tokens.json")) };
}

describe("TokenStore", () => {
  it("stores per owner, case-insensitively, at mode 0600", () => {
    const { file, store: s } = store();
    s.set("Anyshift-io", "ghp_a");
    s.set("lerenn", "ghp_b");
    expect(s.get("anyshift-io")).toBe("ghp_a");
    expect(s.owners()).toEqual(["anyshift-io", "lerenn"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "anyshift-io": "ghp_a", lerenn: "ghp_b" });
  });
  it("clears one owner and keeps the others", () => {
    const { store: s } = store();
    s.set("a", "t1");
    s.set("b", "t2");
    s.clear("a");
    expect(s.has("a")).toBe(false);
    expect(s.has("b")).toBe(true);
  });
  it("rejects bad owners and tokens", () => {
    const { store: s } = store();
    expect(() => normalizeOwner("../x")).toThrow();
    expect(() => normalizeOwner("")).toThrow();
    expect(() => s.set("a", "  ")).toThrow();
    expect(() => s.set("a", "x y")).toThrow();
    expect(() => s.set("a", "x\ny")).toThrow();
  });
  it("derives the same key for the same token only", () => {
    expect(tokenKey("a")).toBe(tokenKey("a"));
    expect(tokenKey("a")).not.toBe(tokenKey("b"));
    expect(tokenKey("secret")).not.toContain("secret");
  });
  it("scrubs secrets from messages", () => {
    expect(scrub("bad secret here", "secret")).toBe("bad *** here");
    expect(scrub("nothing", null)).toBe("nothing");
  });
});
