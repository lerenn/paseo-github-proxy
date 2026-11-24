import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface CacheEntry {
  key: string;
  etag: string | null;
  status: number;
  body: string;
  contentType: string;
  /** The `Link` header, kept so that paginated reads stay coherent. */
  link: string | null;
  fetchedAt: number;
}

/**
 * The key of a response. It includes the credential identity (`gh` or `app:<id>`): what GitHub answers depends on who
 * asks (a private repository is visible to one App and not to another), so an answer is never shared across identities.
 */
export function cacheKey(method: string, url: string, body: string | undefined, identity: string): string {
  const suffix = body ? `#${createHash("sha256").update(body).digest("hex").slice(0, 16)}` : "";
  return `${method.toUpperCase()} ${url}${suffix} as ${identity}`;
}

export function isFresh(entry: CacheEntry, ttlSeconds: number, now: number): boolean {
  return ttlSeconds > 0 && now - entry.fetchedAt < ttlSeconds * 1000;
}

/** An in-memory response cache with an optional on-disk copy that survives restarts. Oldest-used entries go first. */
export class ResponseCache {
  private entries = new Map<string, CacheEntry>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(
    private readonly file: string | null = null,
    private readonly maxEntries = 500,
    private readonly maxBytes = 25_000_000,
    private readonly debounceMs = 1500,
  ) {
    if (file) this.load(file);
  }

  private load(file: string): void {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries?: CacheEntry[] };
      for (const e of parsed.entries ?? []) if (e && typeof e.key === "string" && typeof e.body === "string") this.entries.set(e.key, e);
    } catch {
      /* no cache yet, or an unreadable one: start empty */
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  set(entry: CacheEntry): void {
    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
    this.trim();
    this.schedule();
  }

  /** A 304 says the entry is still good: keep it, restart its clock. */
  touch(key: string, now: number): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.fetchedAt = now;
      this.schedule();
    }
  }

  /** Drops every entry whose key contains the fragment (after a write to that repo). */
  invalidate(fragment: string): void {
    let changed = false;
    for (const key of [...this.entries.keys()]) {
      if (key.includes(fragment)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.schedule();
  }

  clear(): void {
    this.entries.clear();
    this.schedule();
  }

  private trim(): void {
    let bytes = 0;
    for (const e of this.entries.values()) bytes += e.body.length;
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries && bytes <= this.maxBytes) break;
      bytes -= this.entries.get(key)!.body.length;
      this.entries.delete(key);
    }
  }

  private schedule(): void {
    if (!this.file) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, entries: [...this.entries.values()] }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      console.error("[github-proxy] could not write the cache:", (error as Error).message);
    }
  }
}
