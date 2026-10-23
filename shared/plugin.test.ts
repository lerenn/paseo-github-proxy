import { describe, expect, it } from "vitest";
import { isOptedIn, isOptedOut, lockoutApplies } from "./plugin";

describe("isOptedOut", () => {
  it("is false by default", () => {
    expect(isOptedOut(undefined)).toBe(false);
    expect(isOptedOut({})).toBe(false);
    expect(isOptedOut({ PASEO_GITHUB_PROXY: "on" })).toBe(false);
  });
  it("accepts off, 0 and false in any case", () => {
    for (const v of ["off", "OFF", " 0 ", "false"]) expect(isOptedOut({ PASEO_GITHUB_PROXY: v })).toBe(true);
  });
});

describe("lockout scope", () => {
  it("opt-in: only PASEO_GITHUB_PROXY=on agents are covered", () => {
    expect(lockoutApplies("opt-in", undefined)).toBe(false);
    expect(lockoutApplies("opt-in", {})).toBe(false);
    expect(lockoutApplies("opt-in", { PASEO_GITHUB_PROXY: "off" })).toBe(false);
    expect(lockoutApplies("opt-in", { PASEO_GITHUB_PROXY: "garbage" })).toBe(false);
    for (const v of ["on", "ON", " 1 ", "true"]) expect(lockoutApplies("opt-in", { PASEO_GITHUB_PROXY: v })).toBe(true);
    expect(isOptedIn({ PASEO_GITHUB_PROXY: "on" })).toBe(true);
  });
  it("all: everyone except PASEO_GITHUB_PROXY=off", () => {
    expect(lockoutApplies("all", undefined)).toBe(true);
    expect(lockoutApplies("all", { PASEO_GITHUB_PROXY: "on" })).toBe(true);
    expect(lockoutApplies("all", { PASEO_GITHUB_PROXY: "off" })).toBe(false);
  });
});
