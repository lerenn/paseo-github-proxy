import { describe, expect, it } from "vitest";
import { SOURCE_OPTIONS, appSummary, toggleOpen, countdown, percent, presetOf, splitList, summarize, toggleChecked, withAlpha } from "./format";

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
  it("toggles checkable values with an exclusive one", () => {
    expect(toggleChecked(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleChecked(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleChecked(["a", "b"], "*", "*")).toEqual(["*"]);
    expect(toggleChecked(["*"], "a", "*")).toEqual(["a"]);
    expect(toggleChecked(["*"], "*", "*")).toEqual([]);
  });
  it("summarizes a selection", () => {
    const o = { none: "None", exclusive: "*", all: "All owners (*)" };
    expect(summarize([], o)).toBe("None");
    expect(summarize(["*"], o)).toBe("All owners (*)");
    expect(summarize(["acme"], o)).toBe("acme");
    expect(summarize(["a", "b", "c"], o)).toBe("3 selected");
  });
});

describe("source options", () => {
  it("lists both sources once, gh first", () => {
    expect(SOURCE_OPTIONS.map((o) => o.id)).toEqual(["gh", "app"]);
  });
  it("summarizes a collapsed App row", () => {
    expect(appSummary({ owners: ["acme"], appId: "1", default: false })).toBe("acme · App 1");
    expect(appSummary({ owners: ["a", "b"], appId: "1", default: true })).toBe("2 owners · App 1");
    expect(appSummary({ owners: [], appId: "", default: true })).toBe("Rest");
    expect(appSummary({ owners: [], appId: "2", default: false })).toBe("No owner · App 2");
  });
  it("toggles open entries", () => {
    expect(toggleOpen([], "a")).toEqual(["a"]);
    expect(toggleOpen(["a", "b"], "a")).toEqual(["b"]);
  });
});
