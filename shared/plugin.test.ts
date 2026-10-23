import { describe, expect, it } from "vitest";
import { isOptedOut } from "./plugin";

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
