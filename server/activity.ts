import type { Priority } from "../shared/budget";
import type { ActivityEntry } from "../shared/rpc";
import type { AuditEntry } from "../shared/audit";

export interface Call {
  at: number;
  method: string;
  path: string;
  /** HTTP status, or null when the request never got an answer. */
  status: number | null;
  cached: boolean;
  priority: Priority;
}

/** In-memory ring of the latest GitHub calls, for the screen. Nothing is persisted. */
export class CallLog {
  private readonly calls: Call[] = [];
  constructor(private readonly max = 100) {}

  record(call: Call) {
    this.calls.push(call);
    if (this.calls.length > this.max) this.calls.shift();
  }

  all(): readonly Call[] {
    return this.calls;
  }
}

/** A request in plain words. */
export function humanize(method: string, rawPath: string): string {
  const p = rawPath.split("?")[0].replace(/\/+$/, "");
  const m = method.toUpperCase();
  const r = p.match(/^\/repos\/([^/]+\/[^/]+)(?:\/(.*))?$/);
  if (p === "/graphql") return m === "POST" ? "Ran a GraphQL request" : "GraphQL request";
  if (p === "/rate_limit") return "Checked the request budget";
  if (!r) return `${m} ${p}`;
  const repo = r[1];
  const rest = r[2] ?? "";
  const n = (re: RegExp) => rest.match(re)?.[1];
  let x: string | undefined;
  if (m === "GET") {
    if ((x = n(/^pulls\/(\d+)$/))) return `Read pull request ${repo}#${x}`;
    if ((x = n(/^pulls\/(\d+)\/files$/))) return `Read the changed files of ${repo}#${x}`;
    if ((x = n(/^pulls\/(\d+)\/reviews$/))) return `Read the reviews of ${repo}#${x}`;
    if ((x = n(/^(?:pulls|issues)\/(\d+)\/comments$/))) return `Read the comments of ${repo}#${x}`;
    if (/^commits\/[^/]+\/(check-runs|status)$/.test(rest)) return `Read the checks of a commit in ${repo}`;
    if ((x = n(/^issues\/(\d+)$/))) return `Read issue ${repo}#${x}`;
    if (rest === "pulls") return `Listed pull requests of ${repo}`;
    if (rest === "issues") return `Listed issues of ${repo}`;
    if (rest.startsWith("actions/runs")) return `Read workflow runs of ${repo}`;
    if (rest === "") return `Read repository ${repo}`;
    return `Read ${rest} of ${repo}`;
  }
  if ((x = n(/^issues\/(\d+)\/comments$/)) && m === "POST") return `Commented on ${repo}#${x}`;
  if (rest === "pulls" && m === "POST") return `Opened a pull request in ${repo}`;
  if ((x = n(/^issues\/(\d+)\/labels/))) return `Changed labels on ${repo}#${x}`;
  if ((x = n(/^pulls\/(\d+)\/requested_reviewers$/))) return `Requested a review on ${repo}#${x}`;
  if ((x = n(/^pulls\/(\d+)\/merge$/))) return `Merged ${repo}#${x}`;
  if (rest === "hooks" || rest.startsWith("hooks/")) return `Set up the webhook forwarder for ${repo}`;
  return `${m} ${rest} on ${repo}`;
}

/** Latest foreground calls and refused writes, newest first, in plain words. */
export function recentActivity(calls: readonly Call[], audit: readonly AuditEntry[], limit = 10): ActivityEntry[] {
  const fromCalls = calls
    // Background polling and budget checks would drown out what agents did.
    .filter((c) => c.priority !== "background" && !c.path.startsWith("/rate_limit"))
    .map((c): ActivityEntry => ({
      at: new Date(c.at).toISOString(),
      outcome: c.status !== null && c.status < 400 ? "ok" : "failed",
      text: humanize(c.method, c.path) + (c.cached ? " (from cache)" : "") + (c.status !== null && c.status >= 400 ? ` (GitHub answered ${c.status})` : ""),
    }));
  const refused = audit
    .filter((e) => e.decision === "refused")
    .map((e): ActivityEntry => ({ at: e.at, outcome: "refused", text: `Refused: ${e.summary}`, detail: e.detail }));
  return [...fromCalls, ...refused].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
