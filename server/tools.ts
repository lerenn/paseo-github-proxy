import { execFile } from "node:child_process";
import { z } from "zod";
import { defineAgentTool, type AgentToolContext, type AgentToolDefinition, type AgentToolResult } from "@getpaseo/plugin/server";
import { ACTIONS, ACTION_INFO, type Action } from "../shared/actions";
import { ProxyError, type GithubProxy, type ProxyResponse } from "./proxy";

export const SOFT_RULE_PROMPT =
  "GitHub access: do not use the gh CLI, curl, wget or any raw HTTP call to reach api.github.com or other GitHub APIs. Use the github_* tools instead: they apply the user's access policy, share a cache and handle rate limits. " +
  "If a github_* tool denies a call, report the denial to the user and stop; never work around it with gh or curl. Plain git (clone, fetch, push) is unaffected.";
const SOFT_RULE_DESCRIPTION = " Use this instead of the gh CLI or curl.";

const MAX_CHARS = 40_000;

const repoField = z.string().optional().describe("owner/name. Omit to use the repository of your working directory.");
const page = { page: z.number().int().min(1).optional(), per_page: z.number().int().min(1).max(100).optional().describe("Default 30.") };

const gitRemote = (cwd: string): Promise<string> =>
  new Promise((resolve) => {
    execFile("git", ["-C", cwd, "remote", "get-url", "origin"], { timeout: 5000 }, (error, stdout) => resolve(error ? "" : stdout.trim()));
  });

export function repoFromRemote(url: string): string {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : "";
}

export interface ToolsDeps {
  proxy: GithubProxy;
  /** Appends the "use these tools, not gh/curl" sentence to every description. */
  softRule: boolean;
  /** Where to find the origin of a working directory; replaceable in tests. */
  remoteOf?: (cwd: string) => Promise<string>;
}

function clip(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n… truncated (${text.length - MAX_CHARS} more characters). Narrow the request or use page/per_page.` : text;
}

function pagination(r: ProxyResponse): string {
  const next = r.link && /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="next"/.exec(r.link);
  return next ? `\n(more results: request page ${next[1]})` : "";
}

const served = (r: ProxyResponse): string => (r.served === "stale" ? "\n(note: served from an older cache entry because GitHub is rate limiting; it may be out of date)" : "");

/** Builds the agent tools. Rebuilt for each session, so the description reflects the soft rule at that moment. */
export function buildTools(deps: ToolsDeps): AgentToolDefinition[] {
  const { proxy } = deps;
  const remoteOf = deps.remoteOf ?? gitRemote;
  const suffix = deps.softRule ? SOFT_RULE_DESCRIPTION : "";

  const tool = <S extends z.ZodType>(name: string, description: string, input: S, run: (input: z.output<S>, ctx: AgentToolContext, call: ReturnType<typeof makeCall>) => Promise<string>) =>
    defineAgentTool({
      name,
      description: description + suffix,
      input,
      async execute(args, ctx): Promise<AgentToolResult> {
        try {
          return { text: await run(args, ctx, makeCall(ctx, name)) };
        } catch (error) {
          if (error instanceof ProxyError) return { isError: true, text: error.message };
          return { isError: true, text: `${name} failed: ${(error as Error).message}` };
        }
      },
    });

  const makeCall = (ctx: AgentToolContext, name: string) => ({
    ctx: { agentId: ctx.agent.id, agentTitle: ctx.agent.title ?? ctx.agent.id, tool: name },
    async repo(given: string | undefined): Promise<string> {
      const value = (given ?? "").trim() || repoFromRemote(await remoteOf(ctx.agent.cwd));
      if (!/^[^/\s]+\/[^/\s]+$/.test(value)) throw new ProxyError("invalid", "Pass repo as owner/name (it could not be inferred from the working directory).");
      return value;
    },
  });
  type Calls = ReturnType<typeof makeCall>;
  const get = (c: Calls, path: string, query?: Record<string, string | number | undefined>) => proxy.rest(c.ctx, { method: "GET", path, ...(query ? { query } : {}), actions: ["read"] });
  const write = (c: Calls, method: string, path: string, action: Action, body?: unknown) => proxy.rest(c.ctx, { method, path, ...(body !== undefined ? { body } : {}), actions: [action] });

  const pr = (p: Record<string, any>) => ({
    number: p.number, title: p.title, state: p.merged_at ? "merged" : p.state, draft: p.draft, author: p.user?.login, head: p.head?.ref, base: p.base?.ref,
    updated_at: p.updated_at, url: p.html_url, mergeable_state: p.mergeable_state, labels: p.labels?.map((l: any) => l.name),
  });
  const issue = (i: Record<string, any>) => ({
    number: i.number, title: i.title, state: i.state, author: i.user?.login, labels: i.labels?.map((l: any) => l.name), assignees: i.assignees?.map((a: any) => a.login),
    comments: i.comments, updated_at: i.updated_at, url: i.html_url, is_pull_request: !!i.pull_request,
  });

  const tools: AgentToolDefinition[] = [
    tool("github_policy", "Show what you may do on GitHub: allowed owners, and for a repository which actions the policy allows or denies. Call this before attempting a write.", z.object({ repo: repoField }), async ({ repo }, _ctx, c) => {
      const target = await c.repo(repo);
      const rows = ACTIONS.map((a) => {
        const d = proxy.judgeAction(target, [a]);
        return { action: a, label: ACTION_INFO[a].label, allowed: d.allowed, ...(d.allowed ? {} : { why: d.message }) };
      });
      return clip({ repo: target, actions: rows, rateLimits: proxy.overview().sources.filter((s) => s.active) });
    }),

    tool("github_repo_info", "Get repository information: description, default branch, visibility, open issue count.", z.object({ repo: repoField }), async ({ repo }, _ctx, c) => {
      const r = await get(c, `/repos/${await c.repo(repo)}`);
      const d = r.data as Record<string, any>;
      return clip({ full_name: d.full_name, description: d.description, default_branch: d.default_branch, private: d.private, archived: d.archived, open_issues_count: d.open_issues_count, pushed_at: d.pushed_at, url: d.html_url, permissions: d.permissions }) + served(r);
    }),

    tool("github_list_branches", "List branches of a repository.", z.object({ repo: repoField, ...page }), async ({ repo, page: pg, per_page }, _ctx, c) => {
      const r = await get(c, `/repos/${await c.repo(repo)}/branches`, { page: pg, per_page: per_page ?? 30 });
      return clip((r.data as any[]).map((b) => ({ name: b.name, sha: b.commit?.sha, protected: b.protected }))) + pagination(r) + served(r);
    }),

    tool("github_delete_branch", "Delete a branch of a repository.", z.object({ repo: repoField, branch: z.string() }), async ({ repo, branch }, _ctx, c) => {
      const target = await c.repo(repo);
      await write(c, "DELETE", `/repos/${target}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, "delete_branch");
      return `Deleted branch ${branch} of ${target}.`;
    }),

    tool("github_list_prs", "List pull requests of a repository.", z.object({ repo: repoField, state: z.enum(["open", "closed", "all"]).optional(), head: z.string().optional().describe("Filter by head: user:branch."), base: z.string().optional(), ...page }), async ({ repo, state, head, base, page: pg, per_page }, _ctx, c) => {
      const r = await get(c, `/repos/${await c.repo(repo)}/pulls`, { state: state ?? "open", head, base, page: pg, per_page: per_page ?? 30 });
      return clip((r.data as any[]).map(pr)) + pagination(r) + served(r);
    }),

    tool(
      "github_get_pr",
      "Get one pull request. Use include to also fetch its changed files, reviews, or comments.",
      z.object({ repo: repoField, number: z.number().int(), include: z.array(z.enum(["files", "reviews", "comments"])).optional() }),
      async ({ repo, number, include }, _ctx, c) => {
        const target = await c.repo(repo);
        const base = `/repos/${target}/pulls/${number}`;
        const main = await get(c, base);
        const out: Record<string, unknown> = { ...pr(main.data as any), body: (main.data as any).body, additions: (main.data as any).additions, deletions: (main.data as any).deletions, changed_files: (main.data as any).changed_files, head_sha: (main.data as any).head?.sha };
        if (include?.includes("files")) out.files = ((await get(c, `${base}/files`, { per_page: 100 })).data as any[]).map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch?.slice(0, 4000) }));
        if (include?.includes("reviews")) out.reviews = ((await get(c, `${base}/reviews`, { per_page: 100 })).data as any[]).map((v) => ({ user: v.user?.login, state: v.state, body: v.body, submitted_at: v.submitted_at }));
        if (include?.includes("comments")) {
          const issueComments = (await get(c, `/repos/${target}/issues/${number}/comments`, { per_page: 100 })).data as any[];
          const reviewComments = (await get(c, `${base}/comments`, { per_page: 100 })).data as any[];
          out.comments = issueComments.map((m) => ({ user: m.user?.login, body: m.body, at: m.created_at }));
          out.review_comments = reviewComments.map((m) => ({ user: m.user?.login, path: m.path, line: m.line, body: m.body, at: m.created_at }));
        }
        return clip(out) + served(main);
      },
    ),

    tool(
      "github_create_pr",
      "Open a pull request.",
      z.object({ repo: repoField, title: z.string(), head: z.string().describe("The branch with your changes (or owner:branch)."), base: z.string().describe("The branch to merge into."), body: z.string().optional(), draft: z.boolean().optional() }),
      async ({ repo, ...rest }, _ctx, c) => {
        const r = await write(c, "POST", `/repos/${await c.repo(repo)}/pulls`, "create_pr", rest);
        return clip(pr(r.data as any));
      },
    ),

    tool(
      "github_update_pr",
      "Edit a pull request (title, body, base) or close or reopen it.",
      z.object({ repo: repoField, number: z.number().int(), title: z.string().optional(), body: z.string().optional(), base: z.string().optional(), state: z.enum(["open", "closed"]).optional() }),
      async ({ repo, number, ...rest }, _ctx, c) => clip(pr((await write(c, "PATCH", `/repos/${await c.repo(repo)}/pulls/${number}`, "update_pr", rest)).data as any)),
    ),

    tool(
      "github_merge_pr",
      "Merge a pull request. Pass sha (the head commit you reviewed) to refuse the merge if the branch moved.",
      z.object({ repo: repoField, number: z.number().int(), merge_method: z.enum(["merge", "squash", "rebase"]).optional(), commit_title: z.string().optional(), commit_message: z.string().optional(), sha: z.string().optional() }),
      async ({ repo, number, ...rest }, _ctx, c) => clip((await write(c, "PUT", `/repos/${await c.repo(repo)}/pulls/${number}/merge`, "merge", rest)).data),
    ),

    tool("github_comment", "Comment on an issue or a pull request.", z.object({ repo: repoField, number: z.number().int(), body: z.string().min(1) }), async ({ repo, number, body }, _ctx, c) => {
      const r = await write(c, "POST", `/repos/${await c.repo(repo)}/issues/${number}/comments`, "comment", { body });
      return `Comment posted: ${(r.data as any).html_url}`;
    }),

    tool(
      "github_review_pr",
      "Submit a review on a pull request: approve, request changes, or comment.",
      z.object({ repo: repoField, number: z.number().int(), event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]), body: z.string().optional(), comments: z.array(z.object({ path: z.string(), line: z.number().int(), body: z.string(), side: z.enum(["LEFT", "RIGHT"]).optional() })).optional() }),
      async ({ repo, number, ...rest }, _ctx, c) => {
        const r = await write(c, "POST", `/repos/${await c.repo(repo)}/pulls/${number}/reviews`, "review", rest);
        return `Review submitted (${(r.data as any).state}): ${(r.data as any).html_url}`;
      },
    ),

    tool("github_list_issues", "List issues of a repository (pull requests are included by GitHub; see is_pull_request).", z.object({ repo: repoField, state: z.enum(["open", "closed", "all"]).optional(), labels: z.string().optional().describe("Comma-separated."), assignee: z.string().optional(), ...page }), async ({ repo, state, labels, assignee, page: pg, per_page }, _ctx, c) => {
      const r = await get(c, `/repos/${await c.repo(repo)}/issues`, { state: state ?? "open", labels, assignee, page: pg, per_page: per_page ?? 30 });
      return clip((r.data as any[]).map(issue)) + pagination(r) + served(r);
    }),

    tool("github_get_issue", "Get one issue; include_comments also fetches its comments.", z.object({ repo: repoField, number: z.number().int(), include_comments: z.boolean().optional() }), async ({ repo, number, include_comments }, _ctx, c) => {
      const target = await c.repo(repo);
      const r = await get(c, `/repos/${target}/issues/${number}`);
      const out: Record<string, unknown> = { ...issue(r.data as any), body: (r.data as any).body };
      if (include_comments) out.comment_list = ((await get(c, `/repos/${target}/issues/${number}/comments`, { per_page: 100 })).data as any[]).map((m) => ({ user: m.user?.login, body: m.body, at: m.created_at }));
      return clip(out) + served(r);
    }),

    tool("github_create_issue", "Open an issue.", z.object({ repo: repoField, title: z.string(), body: z.string().optional(), labels: z.array(z.string()).optional(), assignees: z.array(z.string()).optional() }), async ({ repo, ...rest }, _ctx, c) =>
      clip(issue((await write(c, "POST", `/repos/${await c.repo(repo)}/issues`, "create_issue", rest)).data as any)),
    ),

    tool(
      "github_checks",
      "CI status of a commit, branch or pull request: check runs and the combined commit status.",
      z.object({ repo: repoField, ref: z.string().optional().describe("Commit SHA or branch."), pr: z.number().int().optional().describe("Pull request number (its head commit is used).") }),
      async ({ repo, ref, pr: prNumber }, _ctx, c) => {
        const target = await c.repo(repo);
        let sha = ref;
        if (!sha && prNumber) sha = ((await get(c, `/repos/${target}/pulls/${prNumber}`)).data as any).head.sha as string;
        if (!sha) throw new ProxyError("invalid", "Pass ref or pr.");
        const enc = sha.split("/").map(encodeURIComponent).join("/");
        const runs = await get(c, `/repos/${target}/commits/${enc}/check-runs`, { per_page: 100 });
        const status = await get(c, `/repos/${target}/commits/${enc}/status`);
        return clip({
          ref: sha,
          state: (status.data as any).state,
          statuses: ((status.data as any).statuses as any[]).map((s) => ({ context: s.context, state: s.state, url: s.target_url })),
          check_runs: ((runs.data as any).check_runs as any[]).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url })),
        }) + served(runs);
      },
    ),

    tool(
      "github_search",
      "Search GitHub. Scope it with repo, org or user (required). type: issues, prs, code, repos or commits.",
      z.object({ query: z.string(), type: z.enum(["issues", "prs", "code", "repos", "commits"]).default("issues"), repo: z.string().optional(), org: z.string().optional(), user: z.string().optional(), ...page }),
      async ({ query, type, repo, org, user, page: pg, per_page }, _ctx, c) => {
        const qualifiers = [repo && `repo:${repo}`, org && `org:${org}`, user && `user:${user}`].filter(Boolean).join(" ");
        const q = [query, type === "prs" ? "is:pr" : type === "issues" ? "is:issue" : "", qualifiers].filter(Boolean).join(" ");
        const endpoint = type === "prs" || type === "issues" ? "issues" : type === "repos" ? "repositories" : type;
        const r = await get(c, `/search/${endpoint}`, { q, page: pg, per_page: per_page ?? 20 });
        const d = r.data as { total_count: number; items: any[] };
        const items = d.items.map((i) => (type === "code" ? { path: i.path, repo: i.repository?.full_name, url: i.html_url } : type === "repos" ? { full_name: i.full_name, description: i.description, stars: i.stargazers_count, url: i.html_url } : type === "commits" ? { sha: i.sha, message: i.commit?.message?.split("\n")[0], repo: i.repository?.full_name, url: i.html_url } : issue(i)));
        return clip({ total_count: d.total_count, items }) + pagination(r) + served(r);
      },
    ),

    tool(
      "github_api",
      "Generic GitHub access for what the other github_* tools do not cover. kind=rest: give method and path (e.g. /repos/o/r/releases). kind=graphql: give query (and repo, variables). Each call is checked against the policy as a generic API read or write and may be denied; prefer the specific tools.",
      z.object({
        kind: z.enum(["rest", "graphql"]),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("REST only. Default GET."),
        path: z.string().optional().describe("REST only, e.g. /repos/owner/name/releases."),
        params: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe("REST only: query string parameters."),
        body: z.unknown().optional().describe("REST only: JSON body."),
        query: z.string().optional().describe("GraphQL only: the document."),
        variables: z.record(z.string(), z.unknown()).optional().describe("GraphQL only."),
        repo: z.string().optional().describe("owner/name the call is about. Required for GraphQL."),
      }),
      async (input, _ctx, c) => {
        if (input.kind === "graphql") {
          if (!input.query) throw new ProxyError("invalid", "GraphQL needs query.");
          const r = await proxy.graphql(c.ctx, { query: input.query, ...(input.variables ? { variables: input.variables } : {}), repo: input.repo ?? "" });
          return clip(r.data) + served(r);
        }
        if (!input.path) throw new ProxyError("invalid", "REST needs path.");
        const r = await proxy.rest(c.ctx, { method: input.method ?? "GET", path: input.path, ...(input.params ? { query: input.params } : {}), ...(input.body !== undefined ? { body: input.body } : {}) });
        return clip(r.data) + pagination(r) + served(r);
      },
    ),
  ];
  return tools;
}
