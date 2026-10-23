import { describe, expect, it } from "vitest";
import type { Check } from "./ops";
import { baselineOf, detect, settled, type Snapshot } from "./watch";

const check = (name: string, bucket: Check["bucket"]): Check => ({ name, state: bucket.toUpperCase(), bucket, link: "", workflow: "", description: "", startedAt: null, completedAt: null });
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  pr: { merged_by: { login: "carol" }, merge_commit_sha: "m1" }, headSha: "s1", merged: false, closed: false,
  checks: [check("ci", "pending")], reviews: [], comments: [], reviewComments: [], ...over,
});
const kinds = ["checks_completed", "review_submitted", "pr_merged", "pr_closed", "comment_created"] as const;
const run = (base: Snapshot, now: Snapshot, over: { state?: object; at?: number; settleMs?: number; ignore?: string[]; events?: readonly (typeof kinds)[number][] } = {}) =>
  detect(over.events ?? kinds, baselineOf(base), now, over.state ?? {}, over.at ?? 1000, over.settleMs ?? 0, over.ignore);

describe("detect", () => {
  it("finds nothing when nothing changed", () => {
    expect(run(snap(), snap()).matches).toEqual([]);
  });

  it("fires checks_completed when pending checks settle, with failures reported", () => {
    const m = run(snap(), snap({ checks: [check("ci", "pass"), check("lint", "fail")] })).matches;
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: "checks_completed", detail: { overall: "fail", sha: "s1" } });
  });

  it("does not fire while any check is pending, or when there are no checks yet", () => {
    expect(run(snap(), snap({ checks: [check("ci", "pass"), check("slow", "pending")] })).matches).toEqual([]);
    expect(run(snap({ checks: [] }), snap({ checks: [] })).matches).toEqual([]);
  });

  it("waits for the checks to stay settled before firing", () => {
    const state = {};
    const done = snap({ checks: [check("ci", "pass")] });
    const first = run(snap(), done, { state, at: 1000, settleMs: 20_000 });
    expect(first.matches).toEqual([]);
    expect(first.recheckInMs).toBeGreaterThan(19_000);
    expect(run(snap(), done, { state, at: 10_000, settleMs: 20_000 }).matches).toEqual([]);
    expect(run(snap(), done, { state, at: 21_000, settleMs: 20_000 }).matches).toHaveLength(1);
  });

  it("restarts the settle window when a new check shows up pending", () => {
    const state: { settledSince?: number } = {};
    run(snap(), snap({ checks: [check("ci", "pass")] }), { state, at: 1000, settleMs: 20_000 });
    expect(state.settledSince).toBe(1000);
    run(snap(), snap({ checks: [check("ci", "pass"), check("late", "pending")] }), { state, at: 5000, settleMs: 20_000 });
    expect(state.settledSince).toBeUndefined();
  });

  it("fires for a new commit's checks even if the old commit was settled", () => {
    const old = snap({ checks: [check("ci", "pass")] });
    const next = snap({ headSha: "s2", checks: [check("ci", "pass")] });
    expect(run(old, next).matches).toHaveLength(1);
    expect(run(old, snap({ headSha: "s2", checks: [check("ci", "pending")] })).matches).toEqual([]);
  });

  it("does not fire checks_completed for already-settled checks on the same commit", () => {
    const done = snap({ checks: [check("ci", "pass")] });
    expect(run(done, done).matches).toEqual([]);
  });

  it("detects merges and closes, and does not call a merge a close", () => {
    expect(run(snap(), snap({ merged: true, closed: true })).matches.map((m) => m.kind)).toEqual(["pr_merged"]);
    expect(run(snap(), snap({ closed: true })).matches.map((m) => m.kind)).toEqual(["pr_closed"]);
    expect(run(snap({ merged: true, closed: true }), snap({ merged: true, closed: true })).matches).toEqual([]);
  });

  it("detects only new submitted reviews", () => {
    const old = snap({ reviews: [{ id: 1, state: "COMMENTED", user: { login: "a" } }] });
    const now = snap({ reviews: [{ id: 1, state: "COMMENTED", user: { login: "a" } }, { id: 2, state: "APPROVED", user: { login: "bob" }, body: "lgtm" }, { id: 3, state: "PENDING", user: { login: "me" } }] });
    const m = run(old, now).matches;
    expect(m).toHaveLength(1);
    expect(m[0].detail.reviews).toEqual([{ author: "bob", state: "APPROVED", body: "lgtm", url: undefined }]);
  });

  it("detects new issue and review comments, and honours ignored authors", () => {
    const now = snap({ comments: [{ id: 1, user: { login: "bob" }, body: "hi" }, { id: 2, user: { login: "Bot" }, body: "x" }], reviewComments: [{ id: 9, user: { login: "ann" }, body: "nit", path: "a.ts" }] });
    const m = run(snap(), now, { ignore: ["bot"] }).matches;
    expect(m[0].detail.comments.map((c: { author: string }) => c.author)).toEqual(["bob", "ann"]);
    expect(run(snap(), now, { ignore: ["bob", "bot", "ann"] }).matches).toEqual([]);
  });

  it("only looks at the subscribed kinds", () => {
    expect(run(snap(), snap({ merged: true, closed: true }), { events: ["comment_created"] }).matches).toEqual([]);
  });

  it("settled needs at least one check", () => {
    expect(settled([])).toBe(false);
    expect(settled(undefined)).toBe(false);
    expect(settled([check("a", "skipping")])).toBe(true);
  });
});
