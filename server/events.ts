/**
 * GitHub webhook events, reduced to what the plugin needs: which cached reads an event makes stale, and, for the
 * events an agent can wait for, a small normalized event. Payload fields are untrusted text: titles are cut short.
 */

export const WAKE_KINDS = ["checks_completed", "review_submitted", "comment_added", "pr_opened", "pr_merged", "pr_closed"] as const;
export type WakeKind = (typeof WAKE_KINDS)[number];

export const WAKE_KIND_INFO: Record<WakeKind, string> = {
  checks_completed: "A check run, check suite, workflow run or commit status finished (conclusion: success, failure, cancelled, ...).",
  review_submitted: "A pull request review was submitted (conclusion: approved, changes_requested, commented).",
  comment_added: "A comment was added to an issue or pull request, or a review comment to a pull request.",
  pr_opened: "A pull request was opened or reopened.",
  pr_merged: "A pull request was merged.",
  pr_closed: "A pull request was closed without being merged.",
};

export interface WakeEvent {
  kind: WakeKind;
  /** `owner/name`, lower-cased. */
  repo: string;
  /** Pull request or issue numbers the event is about (a check can belong to several PRs). */
  numbers: number[];
  /** The commit the event is about, when it has one. */
  sha: string;
  /** Check conclusion or review state, lower-cased; empty when the kind has none. */
  conclusion: string;
  /** Untrusted short text (PR title, check name), single line and truncated. */
  title: string;
  actor: string;
  url: string;
}

/** What an event makes stale: path prefixes under `/repos/{repo}` (empty string = the whole repository). */
export interface Parsed {
  repo: string;
  scopes: string[];
  /** The numbers of pull requests or issues whose own pages are stale. */
  numbers: number[];
  wake: WakeEvent | null;
}

const asRecord = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function shorten(text: unknown, max = 100): string {
  const flat = str(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The owner a delivery is about: the repository's owner, else the organization. Lower-cased; empty if unknown. */
export function eventOwner(payload: unknown): string {
  const p = asRecord(payload);
  const repo = asRecord(p.repository);
  const fromName = str(repo.full_name).split("/")[0] ?? "";
  return (str(asRecord(repo.owner).login) || fromName || str(asRecord(p.organization).login)).toLowerCase();
}

const PR = ["/pulls", "/issues", "/commits"];
const CHECKS = ["/commits", "/check-runs", "/check-suites", "/actions", "/statuses", "/pulls"];

const numbersOf = (list: unknown): number[] => (Array.isArray(list) ? list.map((x) => Number(asRecord(x).number)).filter((n) => Number.isInteger(n) && n > 0) : []);

/** Parses one verified delivery. Null means an event the plugin does not use (it is ignored). */
export function parseEvent(name: string, payloadIn: unknown): Parsed | null {
  const p = asRecord(payloadIn);
  const repo = str(asRecord(p.repository).full_name).toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return null;
  const action = str(p.action);
  const actor = shorten(asRecord(p.sender).login, 39);
  const make = (kind: WakeKind, f: { numbers?: number[]; sha?: string; conclusion?: string; title?: unknown; url?: unknown }): WakeEvent => ({
    kind, repo, numbers: f.numbers ?? [], sha: (f.sha ?? "").toLowerCase(), conclusion: (f.conclusion ?? "").toLowerCase(), title: shorten(f.title), actor, url: str(f.url),
  });
  const done = (scopes: string[], numbers: number[], wake: WakeEvent | null): Parsed => ({ repo, scopes, numbers, wake });

  switch (name) {
    case "pull_request": {
      const pr = asRecord(p.pull_request);
      const n = Number(pr.number ?? p.number);
      const numbers = Number.isInteger(n) ? [n] : [];
      const base = { numbers, sha: str(asRecord(pr.head).sha), title: pr.title, url: pr.html_url };
      const wake = action === "opened" || action === "reopened" ? make("pr_opened", base) : action === "closed" ? make(pr.merged === true ? "pr_merged" : "pr_closed", base) : null;
      return done(["/pulls", "/issues", "/commits", "/branches", "/git", "/compare", "/check-runs", "/actions"], numbers, wake);
    }
    case "pull_request_review": {
      const pr = asRecord(p.pull_request);
      const numbers = numbersOf([pr]);
      const review = asRecord(p.review);
      const wake = action === "submitted" ? make("review_submitted", { numbers, sha: str(review.commit_id), conclusion: str(review.state), title: pr.title, url: review.html_url }) : null;
      return done(PR, numbers, wake);
    }
    case "pull_request_review_comment":
    case "pull_request_review_thread": {
      const pr = asRecord(p.pull_request);
      const numbers = numbersOf([pr]);
      const wake = name === "pull_request_review_comment" && action === "created" ? make("comment_added", { numbers, sha: str(asRecord(p.comment).commit_id), title: pr.title, url: asRecord(p.comment).html_url }) : null;
      return done(PR, numbers, wake);
    }
    case "issue_comment": {
      const issue = asRecord(p.issue);
      const numbers = numbersOf([issue]);
      const wake = action === "created" ? make("comment_added", { numbers, title: issue.title, url: asRecord(p.comment).html_url }) : null;
      return done(["/issues", "/pulls"], numbers, wake);
    }
    case "issues":
      return done(["/issues"], numbersOf([p.issue]), null);
    case "check_run": {
      const run = asRecord(p.check_run);
      const wake = action === "completed" ? make("checks_completed", { numbers: numbersOf(run.pull_requests), sha: str(run.head_sha), conclusion: str(run.conclusion), title: run.name, url: run.html_url }) : null;
      return done(CHECKS, numbersOf(run.pull_requests), wake);
    }
    case "check_suite": {
      const suite = asRecord(p.check_suite);
      const wake = action === "completed" ? make("checks_completed", { numbers: numbersOf(suite.pull_requests), sha: str(suite.head_sha), conclusion: str(suite.conclusion), title: asRecord(suite.app).name, url: suite.url }) : null;
      return done(CHECKS, numbersOf(suite.pull_requests), wake);
    }
    case "workflow_run": {
      const run = asRecord(p.workflow_run);
      const wake = action === "completed" ? make("checks_completed", { numbers: numbersOf(run.pull_requests), sha: str(run.head_sha), conclusion: str(run.conclusion), title: run.name, url: run.html_url }) : null;
      return done(CHECKS, numbersOf(run.pull_requests), wake);
    }
    case "status": {
      const state = str(p.state);
      const wake = state && state !== "pending" ? make("checks_completed", { sha: str(p.sha), conclusion: state === "error" ? "failure" : state, title: p.context, url: p.target_url }) : null;
      return done(CHECKS, [], wake);
    }
    case "push":
      return done([""], [], null);
    default:
      return null;
  }
}

/**
 * The cache keys an event makes stale. A key looks like `GET https://api.github.com/repos/o/r/pulls/5 as app:x`. Matching
 * is on the lower-cased key. The repository's own page and GraphQL reads (review threads) and searches go with any event
 * that changes what they show; an unknown event invalidates nothing because it is ignored before this point.
 */
export function staleKeyTest(parsed: Parsed): (key: string) => boolean {
  const repoPart = `/repos/${parsed.repo}`;
  const prefixes = parsed.scopes.map((s) => `${repoPart}${s}`);
  const wholeRepo = parsed.scopes.includes("");
  return (rawKey) => {
    const key = rawKey.toLowerCase();
    const at = key.indexOf(repoPart);
    if (at >= 0) {
      const rest = key.slice(at + repoPart.length);
      // The repo's own page (`/repos/o/r as ...` or `/repos/o/r?...`) shows open_issues_count, pushed_at, and so on.
      if (rest.startsWith(" as ") || rest.startsWith("?") || rest.startsWith("#")) return true;
      if (wholeRepo) return rest.startsWith("/") || rest.startsWith("?");
      if (prefixes.some((p) => key.slice(at).startsWith(p) && /^[/?# ]/.test(key.slice(at + p.length) || " "))) return true;
    }
    // GraphQL and search answers are keyed by their body or query, not by repository: drop them all.
    return key.includes("/graphql") || key.includes("/search/");
  };
}
