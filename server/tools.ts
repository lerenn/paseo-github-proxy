import { z } from "zod";
import {
  apiGet, getChecks, getDiff, getIssue, getPull, graphqlQuery, listComments, listPulls, ownerOfPath, prFields, resolveRepo,
  type OpsContext,
} from "./ops";

export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodObject;
  run(args: any, ctx: OpsContext): Promise<unknown>;
}

const repo = z.string().optional().describe("owner/name. Defaults to the repository of the working directory.");
const pr = z.string().optional().describe("PR number, URL or branch. Defaults to the current branch.");

const DEFAULT_PR_FIELDS = ["number", "title", "state", "author", "url", "headRefName", "baseRefName", "isDraft", "mergeable", "labels", "body"];

/** Read tools. Write tools are added next to them, behind the write policy. */
export const readTools: ToolDef[] = [
  {
    name: "github_pr_view",
    description: "Show a pull request. Optional fields: number,title,state,body,url,author,headRefName,baseRefName,headRefOid,isDraft,mergeable,labels,reviewRequests,files,comments,reviews,statusCheckRollup,...",
    input: z.object({ repo, pr, fields: z.array(z.string()).optional() }),
    async run({ repo: r, pr: ref, fields }, ctx) {
      const repoId = await resolveRepo(ctx, r);
      return prFields(ctx, repoId, await getPull(ctx, repoId, ref), fields?.length ? fields : DEFAULT_PR_FIELDS);
    },
  },
  {
    name: "github_pr_list",
    description: "List pull requests of a repository.",
    input: z.object({
      repo,
      state: z.enum(["open", "closed", "all"]).optional(),
      head: z.string().optional(),
      base: z.string().optional(),
      author: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async run({ repo: r, ...opts }, ctx) {
      const repoId = await resolveRepo(ctx, r);
      const list = await listPulls(ctx, repoId, opts);
      return Promise.all(list.map((p) => prFields(ctx, repoId, p, ["number", "title", "state", "author", "url", "headRefName", "baseRefName", "isDraft", "updatedAt"])));
    },
  },
  {
    name: "github_pr_checks",
    description: "Check runs and commit statuses of a pull request's head commit, with a pass/fail/pending bucket each.",
    input: z.object({ repo, pr }),
    async run({ repo: r, pr: ref }, ctx) {
      const repoId = await resolveRepo(ctx, r);
      const p = await getPull(ctx, repoId, ref);
      const checks = await getChecks(ctx, repoId, p.head.sha);
      const bucket = checks.some((c) => c.bucket === "fail") ? "fail" : checks.some((c) => c.bucket === "pending") ? "pending" : "pass";
      return { sha: p.head.sha, overall: checks.length ? bucket : "none", checks };
    },
  },
  {
    name: "github_pr_diff",
    description: "Unified diff of a pull request.",
    input: z.object({ repo, pr }),
    async run({ repo: r, pr: ref }, ctx) {
      const repoId = await resolveRepo(ctx, r);
      return getDiff(ctx, repoId, (await getPull(ctx, repoId, ref)).number);
    },
  },
  {
    name: "github_issue_view",
    description: "Show an issue or pull request as an issue.",
    input: z.object({ repo, number: z.number().int() }),
    async run({ repo: r, number }, ctx) {
      return getIssue(ctx, await resolveRepo(ctx, r), number);
    },
  },
  {
    name: "github_comments",
    description: "List the conversation comments of an issue or pull request.",
    input: z.object({ repo, number: z.number().int() }),
    async run({ repo: r, number }, ctx) {
      return listComments(ctx, await resolveRepo(ctx, r), number);
    },
  },
  {
    name: "github_api",
    description: "Read-only GitHub REST call (GET). Path like /repos/{owner}/{repo}/pulls/1/files. Responses are cached and share one rate-limit budget.",
    input: z.object({ path: z.string(), paginate: z.boolean().optional(), repo }),
    async run({ path, paginate, repo: r }, ctx) {
      const fallback = await resolveRepo(ctx, r).then((x) => x.owner, () => undefined);
      return apiGet(ctx, ownerOfPath(path, fallback), path, paginate);
    },
  },
  {
    name: "github_graphql",
    description: "Read-only GitHub GraphQL query (mutations are refused).",
    input: z.object({ query: z.string(), variables: z.record(z.string(), z.unknown()).optional(), owner: z.string().optional().describe("Whose token to use. Defaults to the working directory's repository owner.") }),
    async run({ query, variables, owner }, ctx) {
      const who = owner ?? (await resolveRepo(ctx).then((x) => x.owner, () => undefined));
      if (!who) throw new Error("Pass owner: the working directory has no GitHub remote.");
      return graphqlQuery(ctx, who, query, variables);
    },
  },
  {
    name: "github_rate_limit",
    description: "Remaining shared GitHub rate-limit budget for an owner's token, and whether requests are currently paused.",
    input: z.object({ owner: z.string().optional() }),
    async run({ owner }, ctx) {
      const who = owner ?? (await resolveRepo(ctx).then((x) => x.owner, () => undefined));
      if (!who) throw new Error("Pass owner.");
      return ctx.client.limiter.snapshot(ctx.client.budgetKey(who));
    },
  },
];

export const READ_TOOL_NAMES = readTools.map((t) => t.name);
