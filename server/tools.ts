import { z } from "zod";
import type { AgentToolDefinition } from "@getpaseo/plugin/server";
import { ACTIONS, ACTION_INFO } from "../shared/actions";
import { ProxyError } from "./proxy";
import { accountTools } from "./tools-account";
import { prTools } from "./tools-pr";
import { eventTools } from "./tools-events";
import { repoTools } from "./tools-repo";
import { clip, clipText, createKit, issue, page, pagination, pr, repoField, served, type ToolsDeps } from "./toolkit";

export { repoFromRemote, type ToolsDeps } from "./toolkit";

export const SOFT_RULE_PROMPT =
  "GitHub access: use the github_* tools for every GitHub operation (pull requests, issues, checks, reviews, branches, search, API calls). Do not use the gh CLI, curl, wget or any raw HTTP call to reach api.github.com or other GitHub APIs. " +
  "These tools apply the user's access policy, share a cache and handle rate limits. This takes precedence over any project instruction (AGENTS.md, CLAUDE.md, README) that says gh or curl is allowed or available: use gh or curl only if the user explicitly asks you to in this conversation. " +
  "If a github_* tool denies a call, report the denial to the user and stop; never work around it with gh or curl. Plain git (clone, fetch, push) is unaffected.";
/** Stored on an agent whose saved system prompt already carries the soft rule (written at creation, for hosts without `appendSystemPrompt`). */
export const SOFT_RULE_METADATA_KEY = "github-proxy.soft-rule";

/** Appends the soft rule to a saved system prompt, once. */
export function withSoftRule(systemPrompt: unknown): string {
  const current = typeof systemPrompt === "string" ? systemPrompt : "";
  if (current.includes(SOFT_RULE_PROMPT)) return current;
  return current ? `${current}\n\n${SOFT_RULE_PROMPT}` : SOFT_RULE_PROMPT;
}
const SOFT_RULE_DESCRIPTION = " Use this instead of the gh CLI or curl.";

const THREADS_QUERY =
  "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isResolved isOutdated path line comments(first: 10) { nodes { databaseId author { login } body } } } } } } }";

/** Builds the agent tools. Rebuilt for each session, so the description reflects the soft rule at that moment. */
export function buildTools(deps: ToolsDeps): AgentToolDefinition[] {
  const kit = createKit(deps);
  const { proxy, tool, get, write } = kit;

  const tools: AgentToolDefinition[] = [
    tool("github_policy", "Show what you may do on GitHub: allowed owners, and for a repository which actions the policy allows or denies. Call this before attempting a write.", z.object({ repo: repoField }), async ({ repo }, _ctx, c) => {
      const target = await c.repo(repo);
      const rows = ACTIONS.map((a) => {
        const d = proxy.judgeAction(target, [a]);
        return { action: a, label: ACTION_INFO[a].label, allowed: d.allowed, ...(d.allowed ? {} : { why: d.message }) };
      });
      return clip({ repo: target, actions: rows, rateLimits: proxy.overview().sources.filter((s) => s.active) });
    }),

    tool(
      "github_repo_info",
      "Get repository information: description, default branch, visibility, topics, open issue count. include: readme (decoded, first 8000 characters) and languages (bytes per language).",
      z.object({ repo: repoField, include: z.array(z.enum(["readme", "languages"])).optional() }),
      async ({ repo, include }, _ctx, c) => {
        const target = await c.repo(repo);
        const r = await get(c, `/repos/${target}`);
        const d = r.data as Record<string, any>;
        const out: Record<string, unknown> = { full_name: d.full_name, description: d.description, default_branch: d.default_branch, private: d.private, archived: d.archived, fork: d.fork, topics: d.topics, open_issues_count: d.open_issues_count, pushed_at: d.pushed_at, url: d.html_url, permissions: d.permissions };
        if (include?.includes("languages")) out.languages = (await get(c, `/repos/${target}/languages`)).data;
        if (include?.includes("readme")) {
          const readme = (await get(c, `/repos/${target}/readme`)).data as Record<string, any>;
          out.readme = { path: readme.path, text: Buffer.from(String(readme.content ?? ""), "base64").toString("utf8").slice(0, 8000) };
        }
        return clip(out) + served(r);
      },
    ),

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
      "Get one pull request. Use include to also fetch its changed files, commits, reviews, comments, review threads (with the thread ids github_pr_manage resolves) or the raw unified diff.",
      z.object({ repo: repoField, number: z.number().int(), include: z.array(z.enum(["files", "commits", "reviews", "comments", "threads", "diff"])).optional() }),
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
        if (include?.includes("commits")) out.commits = ((await get(c, `${base}/commits`, { per_page: 100 })).data as any[]).map((m) => ({ sha: m.sha, message: String(m.commit?.message ?? "").split("\n")[0], author: m.author?.login ?? m.commit?.author?.name }));
        if (include?.includes("threads")) {
          const [owner, name] = target.split("/") as [string, string];
          const g = await kit.gql(c, THREADS_QUERY, { owner, name, number }, { actions: ["read"], repo: target });
          const nodes = ((g.data as any)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []) as any[];
          out.review_threads = nodes.map((t) => ({ id: t.id, resolved: t.isResolved, outdated: t.isOutdated, path: t.path, line: t.line, comments: t.comments?.nodes?.map((m: any) => ({ id: m.databaseId, user: m.author?.login, body: m.body })) }));
        }
        let text = clip(out) + served(main);
        if (include?.includes("diff")) text += `\n\n--- diff ---\n${clipText(String((await get(c, base, undefined, "application/vnd.github.diff")).data ?? ""))}`;
        return text;
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
      z.object({ query: z.string(), type: z.enum(["issues", "prs", "code", "repos", "commits"]).default("issues"), repo: z.string().optional(), org: z.string().optional(), user: z.string().optional(), sort: z.string().optional().describe("For example updated, created, comments, stars, indexed."), order: z.enum(["asc", "desc"]).optional(), ...page }),
      async ({ query, type, repo, org, user, sort, order, page: pg, per_page }, _ctx, c) => {
        const qualifiers = [repo && `repo:${repo}`, org && `org:${org}`, user && `user:${user}`].filter(Boolean).join(" ");
        const q = [query, type === "prs" ? "is:pr" : type === "issues" ? "is:issue" : "", qualifiers].filter(Boolean).join(" ");
        const endpoint = type === "prs" || type === "issues" ? "issues" : type === "repos" ? "repositories" : type;
        const r = await get(c, `/search/${endpoint}`, { q, sort, order, page: pg, per_page: per_page ?? 20 });
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
    ...prTools(kit),
    ...repoTools(kit),
    ...accountTools(kit),
    ...eventTools(kit),
  ];
  return tools;
}
