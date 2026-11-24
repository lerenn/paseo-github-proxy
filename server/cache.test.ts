import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheKey, isFresh, ResponseCache, type CacheEntry } from "./cache";

const entry = (key: string, extra: Partial<CacheEntry> = {}): CacheEntry => ({ key, etag: '"a"', status: 200, body: "{}", contentType: "application/json", link: null, fetchedAt: 1000, ...extra });
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("cache", () => {
  it("is fresh within the ttl only; ttl 0 disables freshness", () => {
    const e = entry("k");
    expect(isFresh(e, 30, 1000 + 29_000)).toBe(true);
    expect(isFresh(e, 30, 1000 + 30_000)).toBe(false);
    expect(isFresh(e, 0, 1000)).toBe(false);
  });
  it("keys differ by body", () => {
    expect(cacheKey("POST", "u", "a", "gh")).not.toBe(cacheKey("POST", "u", "b", "gh"));
    expect(cacheKey("get", "u", undefined, "gh")).toBe("GET u as gh");
  });
  it("keys differ by credential identity, so an answer is never shared across Apps or with gh", () => {
    const keys = ["gh", "app:a", "app:b"].map((i) => cacheKey("GET", "https://api.github.com/repos/o/r", undefined, i));
    expect(new Set(keys).size).toBe(3);
  });
  it("evicts the least recently used entry", () => {
    const c = new ResponseCache(null, 2);
    c.set(entry("a"));
    c.set(entry("b"));
    c.get("a");
    c.set(entry("c"));
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBeDefined();
  });
  it("touch restarts the clock; invalidate drops by fragment", () => {
    const c = new ResponseCache(null);
    c.set(entry("GET https://x/repos/a/b/pulls"));
    c.set(entry("GET https://x/repos/c/d/pulls"));
    c.touch("GET https://x/repos/a/b/pulls", 5000);
    expect(c.get("GET https://x/repos/a/b/pulls")?.fetchedAt).toBe(5000);
    c.invalidate("/repos/a/b");
    expect(c.get("GET https://x/repos/a/b/pulls")).toBeUndefined();
    expect(c.size).toBe(1);
  });
  it("survives a restart through the disk copy", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ghp-"));
    dirs.push(dir);
    const file = path.join(dir, "cache.json");
    const first = new ResponseCache(file);
    first.set(entry("k", { body: '{"n":1}' }));
    first.flush();
    expect(new ResponseCache(file).get("k")?.body).toBe('{"n":1}');
  });
  it("starts empty on a corrupt file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ghp-"));
    dirs.push(dir);
    const file = path.join(dir, "cache.json");
    new ResponseCache(file).flush();
    expect(new ResponseCache(path.join(dir, "missing.json")).size).toBe(0);
  });
});
