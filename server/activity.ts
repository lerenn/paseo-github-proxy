import type { ActivityEntry, Stats } from "../shared/state";

const MINUTE = 60_000;
const SERIES_MINUTES = 30;

/** The recent calls (a ring buffer) and the counters behind the Overview tab. */
export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private nextId = 1;
  private buckets = new Map<number, { upstream: number; cached: number }>();
  private totals = { requests: 0, upstream: 0, cacheHits: 0, revalidated: 0, denied: 0, errors: 0 };

  constructor(
    private readonly capacity = 500,
    private readonly clock: () => number = Date.now,
  ) {}

  add(entry: Omit<ActivityEntry, "id" | "at"> & { at?: number }): ActivityEntry {
    const at = entry.at ?? this.clock();
    const full: ActivityEntry = { ...entry, id: this.nextId++, at };
    this.entries.push(full);
    if (this.entries.length > this.capacity) this.entries.shift();
    this.totals.requests++;
    const minute = Math.floor(at / MINUTE);
    const bucket = this.buckets.get(minute) ?? { upstream: 0, cached: 0 };
    switch (full.status) {
      case "allowed":
        this.totals.upstream++;
        bucket.upstream++;
        break;
      case "revalidated":
        this.totals.upstream++;
        this.totals.revalidated++;
        bucket.upstream++;
        break;
      case "cached":
        this.totals.cacheHits++;
        bucket.cached++;
        break;
      case "denied":
        this.totals.denied++;
        break;
      case "rate_limited":
      case "error":
        this.totals.errors++;
        break;
    }
    this.buckets.set(minute, bucket);
    for (const key of this.buckets.keys()) if (key < minute - SERIES_MINUTES) this.buckets.delete(key);
    return full;
  }

  /** Newest first. */
  list(limit = 200): ActivityEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  clear(): void {
    this.entries = [];
  }

  stats(cacheEntries: number): Stats {
    const minute = Math.floor(this.clock() / MINUTE);
    const series = Array.from({ length: SERIES_MINUTES }, (_, i) => this.buckets.get(minute - (SERIES_MINUTES - 1) + i) ?? { upstream: 0, cached: 0 });
    const served = this.totals.upstream + this.totals.cacheHits;
    return {
      ...this.totals,
      // A revalidation (304) is answered from the cache and costs no rate limit.
      hitRate: served === 0 ? 0 : (this.totals.cacheHits + this.totals.revalidated) / served,
      cacheEntries,
      series,
    };
  }
}
