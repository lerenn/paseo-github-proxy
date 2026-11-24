import { describe, expect, it } from "vitest";
import { countdown, percent, presetOf, splitList, withAlpha } from "./format";

describe("format", () => {
  it("counts down", () => {
    expect(countdown(1000, 1000)).toBe("now");
    expect(countdown(46_000, 1000)).toBe("in 45s");
    expect(countdown(1000 + 252_000, 1000)).toBe("in 4m 12s");
    expect(countdown(1000 + 3_900_000, 1000)).toBe("in 1h 05m");
    expect(countdown(0, 5000)).toBe("now");
  });
  it("formats and parses", () => {
    expect(percent(0.756)).toBe("76%");
    expect(splitList("a, b\nb  c,,")).toEqual(["a", "b", "c"]);
    expect(withAlpha("#fff", 0.5)).toBe("#ffffff80");
    expect(withAlpha("rgb(1,2,3)", 0.5)).toBe("rgb(1,2,3)");
  });
  it("names the preset matching a set of actions", () => {
    const presets = { read_only: ["read", "generic_api_read"], full: ["read", "merge"] };
    expect(presetOf(["generic_api_read", "read"], presets)).toBe("read_only");
    expect(presetOf(["read"], presets)).toBe("custom");
  });
});
