import { describe, expect, it, vi } from "vitest";
import { GitHelperFallbacks } from "./githelpers";

describe("GitHelperFallbacks", () => {
  it("reads github.com helpers through git config, no shell, skipping empty lines", async () => {
    const exec = vi.fn(async () => ({ stdout: "!gh git-credential\n\n!/usr/local/bin/gh auth git-credential\n", stderr: "" }));
    expect(await new GitHelperFallbacks(exec).list()).toEqual(["!gh git-credential", "!/usr/local/bin/gh auth git-credential"]);
    expect(exec).toHaveBeenCalledWith("git", ["config", "--get-all", "credential.https://github.com.helper"]);
  });
  it("caches for the ttl, then asks again", async () => {
    let t = 0;
    const exec = vi.fn(async () => ({ stdout: "!a\n", stderr: "" }));
    const f = new GitHelperFallbacks(exec, () => t, 60_000);
    await f.list();
    t = 59_000;
    await f.list();
    expect(exec).toHaveBeenCalledTimes(1);
    t = 61_000;
    await f.list();
    expect(exec).toHaveBeenCalledTimes(2);
  });
  it("means no fallbacks when git config fails", async () => {
    expect(await new GitHelperFallbacks(async () => { throw new Error("exit 1"); }).list()).toEqual([]);
  });
  it("means no fallbacks when git config hangs", async () => {
    const f = new GitHelperFallbacks(() => new Promise(() => {}), Date.now, 60_000, 20);
    expect(await f.list()).toEqual([]);
  });
});
