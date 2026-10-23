import type { OwnerStatus } from "./rpc";
import type { EventKind, SubscriptionView } from "./subscriptions";

export type Scope = "opt-in" | "all";

const number = (n: number) => n.toLocaleString("en-US");

/** Requests left across distinct tokens (owners sharing a token count once), core bucket only. */
export function budgetTotals(owners: readonly OwnerStatus[]): { remaining: number; limit: number } | null {
  let remaining = 0;
  let limit = 0;
  let seen = false;
  const counted = new Set<string>();
  for (const o of owners) {
    if (counted.has(o.owner)) continue;
    for (const other of o.sharesBudgetWith) counted.add(other);
    const core = o.budget.resources.find((r) => r.resource === "core");
    if (core?.remaining != null && core.limit != null) {
      remaining += core.remaining;
      limit += core.limit;
      seen = true;
    }
  }
  return seen ? { remaining, limit } : null;
}

/** The one line at the top of the screen. */
export function statusLine(input: { running: boolean; owners: readonly OwnerStatus[]; scope: Scope | null }): string {
  const parts = [input.running ? "Proxy running" : "Proxy not running"];
  const n = input.owners.length;
  parts.push(n === 0 ? "no tokens yet" : n === 1 ? "1 token" : `${n} tokens`);
  const totals = budgetTotals(input.owners);
  if (totals) parts.push(`${number(totals.remaining)}/${number(totals.limit)} requests left`);
  if (input.scope) parts.push(`lockout: ${input.scope === "opt-in" ? "opt-in" : "all agents"}`);
  return parts.join(" · ");
}

const WAITING_FOR: Record<EventKind, string> = {
  checks_completed: "the checks to finish",
  review_submitted: "a review",
  pr_merged: "the pull request to be merged",
  pr_closed: "the pull request to be closed",
  comment_created: "a new comment",
};

/** An active subscription in plain words. */
export function describeSubscription(s: Pick<SubscriptionView, "repo" | "number" | "events" | "agentId" | "deadline">): string {
  const what = s.events.map((e) => WAITING_FOR[e]).join(" or ");
  const until = new Date(s.deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `An agent (${s.agentId.slice(0, 8)}) is waiting for ${what} on ${s.repo}#${s.number}, until ${until}`;
}
