import type { EventStats } from "../shared/state";

const MINUTE = 60_000;
export const EVENT_SERIES_MINUTES = 30;

export type EventOutcome = "delivered" | "ignored" | "badSignature" | "badOwner" | "duplicate";

const empty = () => ({ delivered: 0, ignored: 0, rejected: 0 });

/**
 * What became of each webhook delivery, in memory: totals and a per-minute series for the last 30 minutes.
 * delivered: woke at least one subscribed agent. ignored: accepted but nobody subscribed (it only invalidated the cache),
 * a ping, or an event type the plugin does not use. rejected: bad signature, wrong owner or a repeated delivery.
 */
export class EventLog {
  private buckets = new Map<number, { delivered: number; ignored: number; rejected: number }>();
  private totals = { delivered: 0, ignored: 0, badSignature: 0, badOwner: 0, duplicate: 0 };

  constructor(private readonly clock: () => number = Date.now) {}

  record(outcome: EventOutcome): void {
    const minute = Math.floor(this.clock() / MINUTE);
    const bucket = this.buckets.get(minute) ?? empty();
    this.totals[outcome]++;
    bucket[outcome === "delivered" || outcome === "ignored" ? outcome : "rejected"]++;
    this.buckets.set(minute, bucket);
    for (const key of this.buckets.keys()) if (key < minute - EVENT_SERIES_MINUTES) this.buckets.delete(key);
  }

  stats(): EventStats {
    const minute = Math.floor(this.clock() / MINUTE);
    const series = Array.from({ length: EVENT_SERIES_MINUTES }, (_, i) => ({ ...(this.buckets.get(minute - (EVENT_SERIES_MINUTES - 1) + i) ?? empty()) }));
    const { delivered, ignored, badSignature, badOwner, duplicate } = this.totals;
    return { received: delivered + ignored + badSignature + badOwner + duplicate, delivered, ignored, badSignature, badOwner, duplicate, series };
  }
}
