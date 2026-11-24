import { describe, expect, it } from "vitest";
import { EventLog } from "./eventstats";

describe("EventLog", () => {
  it("rolls a 30 minute series, oldest first, and keeps the totals", () => {
    let now = 60_000 * 100;
    const log = new EventLog(() => now);
    log.record("delivered");
    log.record("ignored");
    now += 60_000;
    log.record("duplicate");
    log.record("badSignature");
    const s = log.stats();
    expect(s.series).toHaveLength(30);
    expect(s.series.at(-1)).toEqual({ delivered: 0, ignored: 0, rejected: 2 });
    expect(s.series.at(-2)).toEqual({ delivered: 1, ignored: 1, rejected: 0 });
    expect(s.received).toBe(4);
    now += 60_000 * 40;
    const later = log.stats();
    expect(later.series.every((p) => p.delivered + p.ignored + p.rejected === 0)).toBe(true);
    expect(later.received).toBe(4);
    log.record("badOwner");
    expect(log.stats().series.at(-1)).toEqual({ delivered: 0, ignored: 0, rejected: 1 });
  });
});
