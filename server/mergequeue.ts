/** Merge queue and auto-merge state of a pull request, read through GraphQL and reduced to a compact shape. */

export const PR_STATE_QUERY =
  "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id number state isDraft merged mergedAt baseRefName isInMergeQueue mergeStateStatus mergeable reviewDecision autoMergeRequest { mergeMethod enabledBy { login } } mergeQueueEntry { state position estimatedTimeToMerge } commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes { __typename ... on CheckRun { name conclusion } ... on StatusContext { context state } } } } } } } } } }";

export const REQUIRES_QUEUE_QUERY =
  "query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) { mergeQueue(branch: $branch) { id } } }";

export interface MergeStatus {
  merged: boolean;
  merged_at?: string;
  auto_merge: { enabled: boolean; method: string | null; enabled_by?: string };
  merge_queue: { state: string; position?: number; estimated_time_to_merge?: number; failing_check?: string[] } | null;
}

const BAD = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

/** Names of the failing checks and statuses of the head commit. */
export function failingChecks(pr: any): string[] {
  const nodes = (pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []) as any[];
  return nodes.filter((n) => BAD.has(String(n.conclusion ?? n.state))).map((n) => String(n.name ?? n.context));
}

/** The merged, auto-merge and merge queue parts of a GraphQL pull request node. */
export function mergeStatus(pr: any): MergeStatus {
  const entry = pr?.mergeQueueEntry;
  const failing = failingChecks(pr);
  const method = pr?.autoMergeRequest?.mergeMethod;
  return {
    merged: !!pr?.merged,
    ...(pr?.mergedAt ? { merged_at: pr.mergedAt } : {}),
    auto_merge: { enabled: !!pr?.autoMergeRequest, method: method ? String(method).toLowerCase() : null, ...(pr?.autoMergeRequest?.enabledBy?.login ? { enabled_by: pr.autoMergeRequest.enabledBy.login } : {}) },
    merge_queue: entry
      ? { state: entry.state, ...(entry.position != null ? { position: entry.position } : {}), ...(entry.estimatedTimeToMerge != null ? { estimated_time_to_merge: entry.estimatedTimeToMerge } : {}), ...(entry.state === "UNMERGEABLE" && failing.length ? { failing_check: failing } : {}) }
      : null,
  };
}

/** Why a pull request is not queued, in words an agent can act on. */
export function notQueuedReason(pr: any): string {
  if (!pr) return "The pull request could not be read.";
  if (pr.state === "CLOSED") return "The pull request is closed.";
  if (pr.isDraft) return "The pull request is a draft; mark it ready first (github_pr_manage operation ready).";
  const failing = failingChecks(pr);
  if (pr.mergeStateStatus === "DIRTY" || pr.mergeable === "CONFLICTING") return "The branch has merge conflicts with the base; resolve them first.";
  if (failing.length) return `Required checks are failing: ${failing.join(", ")}.`;
  if (pr.reviewDecision === "REVIEW_REQUIRED") return "Required reviews are missing.";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "A reviewer requested changes.";
  if (pr.mergeStateStatus === "BEHIND") return "The branch is behind the base; update it first (github_pr_manage operation update_branch).";
  if (pr.mergeStateStatus === "BLOCKED") return "The merge is blocked by branch protection (checks pending or a required rule not met).";
  return `GitHub did not queue it (merge state ${pr.mergeStateStatus ?? "unknown"}).`;
}

/** The result of auto_merge and disable_auto_merge. */
export function queueResult(pr: any, reason?: string): Record<string, unknown> {
  const s = mergeStatus(pr);
  const queued = !s.merged && (!!s.merge_queue || s.auto_merge.enabled);
  const why = reason ?? (!queued && !s.merged ? notQueuedReason(pr) : undefined);
  return { number: pr?.number, queued, auto_merge: s.auto_merge, merge_queue: s.merge_queue ?? { state: "NOT_QUEUED" }, merged: s.merged, ...(why ? { reason: why } : {}) };
}
