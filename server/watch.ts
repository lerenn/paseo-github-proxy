import type { EventKind } from "../shared/subscriptions";
import { getChecks, getPull, type Check, type OpsContext, type Repo } from "./ops";

type Json = Record<string, any>;

/** What we remember about a pull request at subscription time; later observations are diffed against it. */
export interface Baseline {
  headSha: string;
  checksSettled: boolean;
  reviewIds: number[];
  commentIds: number[];
  reviewCommentIds: number[];
  merged: boolean;
  closed: boolean;
}

export interface Snapshot {
  pr: Json;
  headSha: string;
  merged: boolean;
  closed: boolean;
  checks?: Check[];
  reviews?: Json[];
  comments?: Json[];
  reviewComments?: Json[];
}

export interface Match {
  kind: EventKind;
  /** Facts for the wake-up prompt. */
  detail: Json;
}

const paged = (ctx: OpsContext, repo: Repo, path: string) => ctx.client.restAll<Json>({ owner: repo.owner, path, priority: "background" });

/** Settled: at least one check reported and none still pending. */
export const settled = (checks: Check[] | undefined) => Boolean(checks?.length) && !checks!.some((c) => c.bucket === "pending");

/** Read what the given kinds need. Every call is a conditional request, so unchanged state costs no budget. */
export async function snapshot(ctx: OpsContext, repo: Repo, number: number, kinds: Set<EventKind>): Promise<Snapshot> {
  const pr = await getPull({ ...ctx, priority: "background" }, repo, String(number));
  const base = `/repos/${repo.owner}/${repo.repo}`;
  const snap: Snapshot = { pr, headSha: pr.head.sha, merged: Boolean(pr.merged_at || pr.merged), closed: pr.state === "closed" };
  if (kinds.has("checks_completed")) snap.checks = await getChecks({ ...ctx, priority: "background" }, repo, pr.head.sha);
  if (kinds.has("review_submitted")) snap.reviews = await paged(ctx, repo, `${base}/pulls/${number}/reviews?per_page=100`);
  if (kinds.has("comment_created")) {
    snap.comments = await paged(ctx, repo, `${base}/issues/${number}/comments?per_page=100`);
    snap.reviewComments = await paged(ctx, repo, `${base}/pulls/${number}/comments?per_page=100`);
  }
  return snap;
}

export function baselineOf(snap: Snapshot): Baseline {
  return {
    headSha: snap.headSha,
    checksSettled: settled(snap.checks),
    reviewIds: (snap.reviews ?? []).map((r) => r.id),
    commentIds: (snap.comments ?? []).map((c) => c.id),
    reviewCommentIds: (snap.reviewComments ?? []).map((c) => c.id),
    merged: snap.merged,
    closed: snap.closed,
  };
}

export interface WatchState {
  /** When the checks were first seen settled for the current head, to avoid firing on a partial suite. */
  settledSince?: number;
}

/**
 * Events the snapshot shows beyond the baseline. `settleMs` is how long checks must stay settled
 * before checks_completed fires: a suite that has only reported its fast checks is not finished.
 */
export function detect(
  kinds: readonly EventKind[],
  baseline: Baseline,
  snap: Snapshot,
  state: WatchState,
  now: number,
  settleMs: number,
  ignoreAuthors: readonly string[] = [],
): { matches: Match[]; recheckInMs: number | null } {
  const matches: Match[] = [];
  let recheckInMs: number | null = null;
  const ignored = new Set(ignoreAuthors.map((a) => a.toLowerCase()));
  const by = (u: Json | null | undefined) => u?.login ?? "unknown";

  if (kinds.includes("pr_merged") && snap.merged && !baseline.merged) {
    matches.push({ kind: "pr_merged", detail: { mergedBy: by(snap.pr.merged_by), mergeCommit: snap.pr.merge_commit_sha ?? null } });
  }
  if (kinds.includes("pr_closed") && snap.closed && !snap.merged && !baseline.closed) {
    matches.push({ kind: "pr_closed", detail: {} });
  }
  if (kinds.includes("review_submitted")) {
    const seen = new Set(baseline.reviewIds);
    const fresh = (snap.reviews ?? []).filter((r) => !seen.has(r.id) && r.state !== "PENDING" && !ignored.has(by(r.user).toLowerCase()));
    if (fresh.length) {
      matches.push({ kind: "review_submitted", detail: { reviews: fresh.map((r) => ({ author: by(r.user), state: r.state, body: r.body ?? "", url: r.html_url })) } });
    }
  }
  if (kinds.includes("comment_created")) {
    const seenIssue = new Set(baseline.commentIds);
    const seenReview = new Set(baseline.reviewCommentIds);
    const fresh = [
      ...(snap.comments ?? []).filter((c) => !seenIssue.has(c.id)),
      ...(snap.reviewComments ?? []).filter((c) => !seenReview.has(c.id)),
    ].filter((c) => !ignored.has(by(c.user).toLowerCase()));
    if (fresh.length) {
      matches.push({ kind: "comment_created", detail: { comments: fresh.map((c) => ({ author: by(c.user), body: c.body ?? "", url: c.html_url, path: c.path ?? null })) } });
    }
  }
  if (kinds.includes("checks_completed")) {
    const isSettled = settled(snap.checks);
    const newCommit = snap.headSha !== baseline.headSha;
    if (!isSettled) {
      state.settledSince = undefined;
    } else if (newCommit || !baseline.checksSettled) {
      state.settledSince ??= now;
      if (now - state.settledSince >= settleMs) {
        const checks = snap.checks!;
        matches.push({
          kind: "checks_completed",
          detail: { sha: snap.headSha, overall: checks.some((c) => c.bucket === "fail") ? "fail" : "pass", checks: checks.map((c) => ({ name: c.name, bucket: c.bucket, link: c.link })) },
        });
      } else {
        recheckInMs = settleMs - (now - state.settledSince) + 1000;
      }
    }
  }
  return { matches, recheckInMs };
}
