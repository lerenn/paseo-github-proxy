import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Priority } from "../shared/budget";
import type { GitHubClient } from "./github";
import type { SubscriptionManager } from "./subscriptions";
import type { WriteGate } from "./write";

const run = promisify(execFile);

export interface OpsContext {
  client: GitHubClient;
  /** Working directory of the calling agent, used to infer repository and branch. */
  cwd?: string;
  priority?: Priority;
  /** Present for MCP calls; the gh shim never writes. */
  write?: WriteGate;
  subscriptions?: SubscriptionManager;
  /** The calling agent, once its session is bound. */
  agentId?: string | null;
}

export interface Repo {
  owner: string;
  repo: string;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** `owner/repo`, a github.com URL, or an ssh/https remote URL. */
export function parseRepo(text: string): Repo | null {
  const m =
    text.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/) ??
    text.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Repository from an explicit argument, else the `origin` remote of the agent's directory. */
export async function resolveRepo(ctx: OpsContext, arg?: string): Promise<Repo> {
  if (arg) {
    const parsed = parseRepo(arg);
    if (!parsed) throw new UsageError(`Not a repository: ${arg}. Use owner/repo.`);
    return parsed;
  }
  if (ctx.cwd) {
    try {
      const { stdout } = await run("git", ["-C", ctx.cwd, "remote", "get-url", "origin"]);
      const parsed = parseRepo(stdout.trim());
      if (parsed) return parsed;
    } catch {
      // fall through to the usage error
    }
  }
  throw new UsageError("Could not infer the repository from the working directory. Pass repo as owner/name.");
}

async function currentBranch(cwd?: string): Promise<string | null> {
  if (!cwd) return null;
  try {
    const { stdout } = await run("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

type Json = Record<string, any>;

const get = <T = any>(ctx: OpsContext, repo: Repo, path: string, accept?: string) =>
  ctx.client.rest<T>({ owner: repo.owner, path, priority: ctx.priority, accept });
const all = <T = any>(ctx: OpsContext, repo: Repo, path: string) =>
  ctx.client.restAll<T>({ owner: repo.owner, path, priority: ctx.priority });
const base = (r: Repo) => `/repos/${r.owner}/${r.repo}`;

/** A pull request by number, URL, or branch name; with no reference, the agent's current branch. */
export async function getPull(ctx: OpsContext, repo: Repo, ref?: string): Promise<Json> {
  let number = ref && /^#?\d+$/.test(ref) ? Number(ref.replace("#", "")) : undefined;
  if (ref && number === undefined) {
    const url = ref.match(/\/pull\/(\d+)/);
    if (url) number = Number(url[1]);
  }
  if (number !== undefined) return (await get(ctx, repo, `${base(repo)}/pulls/${number}`)).data;
  const branch = ref ?? (await currentBranch(ctx.cwd));
  if (!branch) throw new UsageError("Pass a pull request number, URL or branch.");
  const head = branch.includes(":") ? branch : `${repo.owner}:${branch}`;
  const list = (await get<Json[]>(ctx, repo, `${base(repo)}/pulls?head=${encodeURIComponent(head)}&state=all&per_page=1`)).data;
  if (!list[0]) throw new UsageError(`No pull request found for branch ${branch}`);
  return (await get(ctx, repo, `${base(repo)}/pulls/${list[0].number}`)).data;
}

const state = (pr: Json) => (pr.merged_at || pr.merged ? "MERGED" : String(pr.state).toUpperCase());
const user = (u: Json | null | undefined) => (u ? { login: u.login, id: u.node_id ?? u.id, type: u.type } : null);

export interface Check {
  name: string;
  state: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
  link: string;
  workflow: string;
  description: string;
  startedAt: string | null;
  completedAt: string | null;
}

function checkBucket(conclusion: string | null, status: string): Check["bucket"] {
  if (status !== "completed") return "pending";
  switch (conclusion) {
    case "success":
    case "neutral":
      return "pass";
    case "skipped":
      return "skipping";
    case "cancelled":
      return "cancel";
    default:
      return "fail";
  }
}

/** Check runs and commit statuses for a commit, in the shape `gh pr checks --json` uses. */
export async function getChecks(ctx: OpsContext, repo: Repo, sha: string): Promise<Check[]> {
  const runs = (await get<Json>(ctx, repo, `${base(repo)}/commits/${sha}/check-runs?per_page=100`)).data.check_runs as Json[];
  const statuses = (await get<Json>(ctx, repo, `${base(repo)}/commits/${sha}/status`)).data.statuses as Json[];
  return [
    ...runs.map((r): Check => ({
      name: r.name,
      state: String(r.status === "completed" ? r.conclusion : r.status).toUpperCase(),
      bucket: checkBucket(r.conclusion, r.status),
      link: r.html_url ?? "",
      workflow: r.app?.name ?? "",
      description: r.output?.title ?? "",
      startedAt: r.started_at ?? null,
      completedAt: r.completed_at ?? null,
    })),
    ...statuses.map((s): Check => ({
      name: s.context,
      state: String(s.state).toUpperCase(),
      bucket: s.state === "success" ? "pass" : s.state === "pending" ? "pending" : "fail",
      link: s.target_url ?? "",
      workflow: "",
      description: s.description ?? "",
      startedAt: s.created_at ?? null,
      completedAt: s.state === "pending" ? null : (s.updated_at ?? null),
    })),
  ];
}

/** Supported `gh pr view --json` fields. */
export const PR_FIELDS = [
  "number", "title", "state", "body", "url", "author", "headRefName", "baseRefName", "headRefOid", "isDraft",
  "mergeable", "mergedAt", "closedAt", "createdAt", "updatedAt", "labels", "assignees", "reviewRequests",
  "additions", "deletions", "changedFiles", "files", "comments", "reviews", "statusCheckRollup", "mergeCommit",
] as const;

export async function prFields(ctx: OpsContext, repo: Repo, pr: Json, fields: readonly string[]): Promise<Json> {
  const out: Json = {};
  for (const f of fields) {
    switch (f) {
      case "number": out.number = pr.number; break;
      case "title": out.title = pr.title; break;
      case "state": out.state = state(pr); break;
      case "body": out.body = pr.body ?? ""; break;
      case "url": out.url = pr.html_url; break;
      case "author": out.author = user(pr.user); break;
      case "headRefName": out.headRefName = pr.head.ref; break;
      case "baseRefName": out.baseRefName = pr.base.ref; break;
      case "headRefOid": out.headRefOid = pr.head.sha; break;
      case "isDraft": out.isDraft = Boolean(pr.draft); break;
      case "mergeable": out.mergeable = pr.mergeable === null ? "UNKNOWN" : pr.mergeable ? "MERGEABLE" : "CONFLICTING"; break;
      case "mergedAt": out.mergedAt = pr.merged_at; break;
      case "closedAt": out.closedAt = pr.closed_at; break;
      case "createdAt": out.createdAt = pr.created_at; break;
      case "updatedAt": out.updatedAt = pr.updated_at; break;
      case "labels": out.labels = (pr.labels ?? []).map((l: Json) => ({ name: l.name, color: l.color, description: l.description })); break;
      case "assignees": out.assignees = (pr.assignees ?? []).map(user); break;
      case "reviewRequests": out.reviewRequests = [...(pr.requested_reviewers ?? []).map(user), ...(pr.requested_teams ?? []).map((t: Json) => ({ name: t.name, slug: t.slug }))]; break;
      case "additions": out.additions = pr.additions; break;
      case "deletions": out.deletions = pr.deletions; break;
      case "changedFiles": out.changedFiles = pr.changed_files; break;
      case "mergeCommit": out.mergeCommit = pr.merge_commit_sha ? { oid: pr.merge_commit_sha } : null; break;
      case "files":
        out.files = (await all<Json>(ctx, repo, `${base(repo)}/pulls/${pr.number}/files?per_page=100`)).map((f) => ({
          path: f.filename, additions: f.additions, deletions: f.deletions, status: f.status,
        }));
        break;
      case "comments":
        out.comments = (await all<Json>(ctx, repo, `${base(repo)}/issues/${pr.number}/comments?per_page=100`)).map((c) => ({
          id: c.node_id, author: user(c.user), body: c.body, createdAt: c.created_at, url: c.html_url,
        }));
        break;
      case "reviews":
        out.reviews = (await all<Json>(ctx, repo, `${base(repo)}/pulls/${pr.number}/reviews?per_page=100`)).map((r) => ({
          id: r.node_id, author: user(r.user), body: r.body, state: r.state, submittedAt: r.submitted_at,
        }));
        break;
      case "statusCheckRollup":
        out.statusCheckRollup = (await getChecks(ctx, repo, pr.head.sha)).map((c) => ({
          name: c.name, status: c.bucket === "pending" ? "IN_PROGRESS" : "COMPLETED", conclusion: c.bucket === "pending" ? "" : c.state, detailsUrl: c.link, workflowName: c.workflow,
        }));
        break;
      default:
        throw new UsageError(`Unknown JSON field: "${f}". Available fields: ${PR_FIELDS.join(", ")}`);
    }
  }
  return out;
}

export async function listPulls(
  ctx: OpsContext,
  repo: Repo,
  opts: { state?: "open" | "closed" | "all"; head?: string; base?: string; author?: string; limit?: number },
): Promise<Json[]> {
  const params = new URLSearchParams({ state: opts.state ?? "open", per_page: String(Math.min(opts.limit ?? 30, 100)) });
  if (opts.head) params.set("head", opts.head.includes(":") ? opts.head : `${repo.owner}:${opts.head}`);
  if (opts.base) params.set("base", opts.base);
  const list = (await get<Json[]>(ctx, repo, `${base(repo)}/pulls?${params}`)).data;
  return list.filter((p) => !opts.author || p.user?.login === opts.author).slice(0, opts.limit ?? 30);
}

export async function getDiff(ctx: OpsContext, repo: Repo, number: number): Promise<string> {
  return (await get<string>(ctx, repo, `${base(repo)}/pulls/${number}`, "application/vnd.github.diff")).data;
}

export async function getIssue(ctx: OpsContext, repo: Repo, number: number): Promise<Json> {
  return (await get(ctx, repo, `${base(repo)}/issues/${number}`)).data;
}

export async function listIssues(ctx: OpsContext, repo: Repo, opts: { state?: string; labels?: string; limit?: number }): Promise<Json[]> {
  const params = new URLSearchParams({ state: opts.state ?? "open", per_page: String(Math.min(opts.limit ?? 30, 100)) });
  if (opts.labels) params.set("labels", opts.labels);
  const list = (await get<Json[]>(ctx, repo, `${base(repo)}/issues?${params}`)).data;
  return list.filter((i) => !i.pull_request).slice(0, opts.limit ?? 30);
}

export async function listComments(ctx: OpsContext, repo: Repo, number: number): Promise<Json[]> {
  return all(ctx, repo, `${base(repo)}/issues/${number}/comments?per_page=100`);
}

export async function listRuns(ctx: OpsContext, repo: Repo, opts: { branch?: string; limit?: number }): Promise<Json[]> {
  const params = new URLSearchParams({ per_page: String(Math.min(opts.limit ?? 20, 100)) });
  if (opts.branch) params.set("branch", opts.branch);
  return (await get<Json>(ctx, repo, `${base(repo)}/actions/runs?${params}`)).data.workflow_runs;
}

export async function getRun(ctx: OpsContext, repo: Repo, id: number): Promise<{ run: Json; jobs: Json[] }> {
  const run = (await get(ctx, repo, `${base(repo)}/actions/runs/${id}`)).data;
  const jobs = (await get<Json>(ctx, repo, `${base(repo)}/actions/runs/${id}/jobs?per_page=100`)).data.jobs;
  return { run, jobs };
}

export async function getRepo(ctx: OpsContext, repo: Repo): Promise<Json> {
  return (await get(ctx, repo, base(repo))).data;
}

/** Read-only REST call on an arbitrary path. */
export async function apiGet(ctx: OpsContext, owner: string, path: string, paginate = false): Promise<unknown> {
  if (!path.startsWith("/")) path = `/${path}`;
  return paginate
    ? ctx.client.restAll({ owner, path, priority: ctx.priority })
    : (await ctx.client.rest({ owner, path, priority: ctx.priority })).data;
}

/** GraphQL query. Mutations are refused here; writes go through the write tools. */
export async function graphqlQuery(ctx: OpsContext, owner: string, query: string, variables?: Record<string, unknown>) {
  if (/(^|[}\s])mutation\b/.test(query.replace(/#.*$/gm, ""))) {
    throw new UsageError("GraphQL mutations are not available through the read tools.");
  }
  return ctx.client.graphql({ owner, query, variables, priority: ctx.priority });
}

/** Owner of a REST path such as `/repos/o/r/...` or `repos/o/r/...`. */
export function ownerOfPath(path: string, fallback?: string): string {
  const m = path.match(/^\/?(?:repos|orgs|users)\/([^/]+)/);
  const owner = m?.[1] ?? fallback;
  if (!owner) throw new UsageError("Cannot tell which owner this path belongs to. Use a /repos/{owner}/{repo}/... path or pass repo.");
  return owner;
}
