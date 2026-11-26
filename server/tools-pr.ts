import { z } from "zod";
import type { AgentToolDefinition } from "@getpaseo/plugin/server";
import { ProxyError } from "./proxy";
import { PR_STATE_QUERY, REQUIRES_QUEUE_QUERY, queueResult } from "./mergequeue";
import { clip, clipText, encPath, issue, need, page, pagination, repoField, served, type Kit } from "./toolkit";

/** `/dir/file` for a path inside the repository, or nothing for its root. */
const contentPath = (path: string | undefined): string => {
  const clean = (path ?? "").replace(/^\/+|\/+$/g, "");
  return clean ? `/${encPath(clean)}` : "";
};

const MERGE_METHODS = { merge: "MERGE", squash: "SQUASH", rebase: "REBASE" } as const;

/** Commits, files, branches, issue edits and pull request management. */
export function prTools(kit: Kit): AgentToolDefinition[] {
  const { tool, get, write, gql } = kit;
  const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

  const file = (f: any) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch?.slice(0, 4000) });
  const commit = (m: any) => ({ sha: m.sha, message: String(m.commit?.message ?? "").split("\n")[0], author: m.author?.login ?? m.commit?.author?.name, date: m.commit?.author?.date, url: m.html_url });

  return [
    tool(
      "github_commits",
      "Read commit history. operation=list: commits of a branch, tag or SHA (ref), optionally for a path, author or date range. operation=get: one commit with its changed files (diff=true for the raw unified diff). operation=compare: base...head with ahead/behind counts, commits and files (diff=true for the raw diff).",
      z.object({
        operation: z.enum(["list", "get", "compare"]),
        repo: repoField,
        ref: z.string().optional().describe("list/get: branch, tag or SHA. list defaults to the default branch."),
        path: z.string().optional().describe("list: only commits touching this path."),
        author: z.string().optional().describe("list: GitHub login or email."),
        since: z.string().optional().describe("list: ISO 8601 date."),
        until: z.string().optional().describe("list: ISO 8601 date."),
        base: z.string().optional().describe("compare: the base branch, tag or SHA."),
        head: z.string().optional().describe("compare: the head branch, tag or SHA."),
        diff: z.boolean().optional().describe("get/compare: return the raw unified diff instead of the file list."),
        ...page,
      }),
      async (i, _ctx, c) => {
        const target = await c.repo(i.repo);
        if (i.operation === "list") {
          const r = await get(c, `/repos/${target}/commits`, { sha: i.ref, path: i.path, author: i.author, since: i.since, until: i.until, page: i.page, per_page: i.per_page ?? 30 });
          return clip((r.data as any[]).map(commit)) + pagination(r) + served(r);
        }
        if (i.operation === "get") {
          const ref = need(i.ref, "ref", "get");
          const url = `/repos/${target}/commits/${encPath(ref)}`;
          if (i.diff) return clipText(String((await get(c, url, undefined, "application/vnd.github.diff")).data ?? ""));
          const r = await get(c, url);
          const d = r.data as any;
          return clip({ ...commit(d), stats: d.stats, parents: d.parents?.map((p: any) => p.sha), files: d.files?.map(file) }) + served(r);
        }
        const range = `${encPath(need(i.base, "base", "compare"))}...${encPath(need(i.head, "head", "compare"))}`;
        if (i.diff) return clipText(String((await get(c, `/repos/${target}/compare/${range}`, undefined, "application/vnd.github.diff")).data ?? ""));
        const r = await get(c, `/repos/${target}/compare/${range}`, { per_page: 100 });
        const d = r.data as any;
        return clip({ status: d.status, ahead_by: d.ahead_by, behind_by: d.behind_by, total_commits: d.total_commits, commits: d.commits?.map(commit), files: d.files?.map(file) }) + served(r);
      },
    ),

    tool(
      "github_contents",
      "Read and change repository files without a local checkout. operation=read: a file (decoded text) or a directory listing at ref. operation=tree: every path of the repository at ref. operation=write: create or update a file (a commit on branch; pass sha of the existing file to update it). operation=delete: delete a file (sha required). operation=create_branch: create a branch from another branch or a SHA. Writes are checked as Write file / Create branch, which the policy may deny.",
      z.object({
        operation: z.enum(["read", "tree", "write", "delete", "create_branch"]),
        repo: repoField,
        path: z.string().optional().describe("read/write/delete: the file or directory path (read: empty for the root)."),
        ref: z.string().optional().describe("read/tree: branch, tag or SHA. Default: the default branch."),
        content: z.string().optional().describe("write: the new text of the file."),
        message: z.string().optional().describe("write/delete: the commit message."),
        branch: z.string().optional().describe("write/delete: the branch to commit to (default: the default branch). create_branch: the new branch name."),
        sha: z.string().optional().describe("write (update) and delete: the blob sha of the file being replaced, from operation=read."),
        from: z.string().optional().describe("create_branch: branch or SHA to start from. Default: the default branch."),
      }),
      async (i, _ctx, c) => {
        const target = await c.repo(i.repo);
        if (i.operation === "read") {
          const r = await get(c, `/repos/${target}/contents${contentPath(i.path)}`, { ref: i.ref });
          const d = r.data as any;
          if (Array.isArray(d)) return clip(d.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size, sha: e.sha }))) + served(r);
          const text = d.encoding === "base64" ? Buffer.from(String(d.content ?? ""), "base64").toString("utf8") : String(d.content ?? "");
          return clip({ path: d.path, sha: d.sha, size: d.size, type: d.type, ...(d.type === "file" && d.encoding !== "base64" ? { note: "Content is not inline (the file is too large). Use github_commits get with diff, or github_api." } : {}), content: clipText(text, 30_000) }) + served(r);
        }
        if (i.operation === "tree") {
          const r = await get(c, `/repos/${target}/git/trees/${encPath(i.ref ?? (await defaultBranch(c, target)))}`, { recursive: 1 });
          const d = r.data as any;
          return clip({ truncated: d.truncated, paths: (d.tree as any[]).filter((e) => e.type === "blob").map((e) => e.path) }) + served(r);
        }
        if (i.operation === "write") {
          const body = { message: need(i.message, "message", "write"), content: base64(need(i.content, "content", "write")), ...(i.branch ? { branch: i.branch } : {}), ...(i.sha ? { sha: i.sha } : {}) };
          const r = await write(c, "PUT", `/repos/${target}/contents${contentPath(need(i.path, "path", "write"))}`, "write_file", body);
          const d = r.data as any;
          return clip({ path: d.content?.path, sha: d.content?.sha, commit: d.commit?.sha, url: d.commit?.html_url });
        }
        if (i.operation === "delete") {
          const body = { message: need(i.message, "message", "delete"), sha: need(i.sha, "sha", "delete"), ...(i.branch ? { branch: i.branch } : {}) };
          const r = await write(c, "DELETE", `/repos/${target}/contents${contentPath(need(i.path, "path", "delete"))}`, "write_file", body);
          return `Deleted ${i.path}: commit ${(r.data as any).commit?.sha}`;
        }
        const name = need(i.branch, "branch (the new branch name)", "create_branch");
        const from = i.from ?? (await defaultBranch(c, target));
        const sha = /^[0-9a-f]{40}$/i.test(from) ? from : (((await get(c, `/repos/${target}/git/ref/heads/${encPath(from)}`)).data as any).object?.sha as string);
        await write(c, "POST", `/repos/${target}/git/refs`, "create_branch", { ref: `refs/heads/${name}`, sha });
        return `Created branch ${name} of ${target} at ${sha}.`;
      },
    ),

    tool(
      "github_update_issue",
      "Edit an issue or a pull request (PRs are issues for labels, assignees and locking): title, body, state (close or reopen, with state_reason), milestone, labels (replace the set), add_labels, remove_labels, add_assignees, remove_assignees, and lock or unlock. Each part is one call checked as Update PR.",
      z.object({
        repo: repoField,
        number: z.number().int(),
        title: z.string().optional(),
        body: z.string().optional(),
        state: z.enum(["open", "closed"]).optional(),
        state_reason: z.enum(["completed", "not_planned", "reopened"]).optional().describe("Why an issue is closed or reopened."),
        milestone: z.number().int().nullable().optional().describe("Milestone number, or null to clear."),
        labels: z.array(z.string()).optional().describe("Replace all labels with these."),
        assignees: z.array(z.string()).optional().describe("Replace all assignees with these."),
        add_labels: z.array(z.string()).optional(),
        remove_labels: z.array(z.string()).optional(),
        add_assignees: z.array(z.string()).optional(),
        remove_assignees: z.array(z.string()).optional(),
        lock: z.enum(["lock", "unlock"]).optional(),
        lock_reason: z.enum(["off-topic", "too heated", "resolved", "spam"]).optional(),
      }),
      async (i, _ctx, c) => {
        const target = await c.repo(i.repo);
        const url = `/repos/${target}/issues/${i.number}`;
        const done: string[] = [];
        const patch: Record<string, unknown> = {};
        for (const k of ["title", "body", "state", "state_reason", "milestone", "labels", "assignees"] as const) if (i[k] !== undefined) patch[k] = i[k];
        let shown: unknown;
        if (Object.keys(patch).length) {
          shown = issue((await write(c, "PATCH", url, "update_pr", patch)).data as any);
          done.push(`edited ${Object.keys(patch).join(", ")}`);
        }
        if (i.add_labels?.length) (await write(c, "POST", `${url}/labels`, "update_pr", { labels: i.add_labels }), done.push(`added labels ${i.add_labels.join(", ")}`));
        for (const l of i.remove_labels ?? []) (await write(c, "DELETE", `${url}/labels/${encodeURIComponent(l)}`, "update_pr"), done.push(`removed label ${l}`));
        if (i.add_assignees?.length) (await write(c, "POST", `${url}/assignees`, "update_pr", { assignees: i.add_assignees }), done.push(`assigned ${i.add_assignees.join(", ")}`));
        if (i.remove_assignees?.length) (await write(c, "DELETE", `${url}/assignees`, "update_pr", { assignees: i.remove_assignees }), done.push(`unassigned ${i.remove_assignees.join(", ")}`));
        if (i.lock === "lock") (await write(c, "PUT", `${url}/lock`, "update_pr", i.lock_reason ? { lock_reason: i.lock_reason } : {}), done.push("locked"));
        if (i.lock === "unlock") (await write(c, "DELETE", `${url}/lock`, "update_pr"), done.push("unlocked"));
        if (done.length === 0) throw new ProxyError("invalid", "Nothing to change: pass at least one field to edit.");
        return clip({ repo: target, number: i.number, done, ...(shown ? { issue: shown } : {}) });
      },
    ),

    tool(
      "github_pr_manage",
      "Manage a pull request beyond editing it. operation: ready (mark ready for review), draft (convert to draft), update_branch (merge the base into the head; optional sha), auto_merge (enable auto-merge, or add the pull request to the merge queue when the base branch requires one; merge_method applies to auto-merge only), disable_auto_merge, request_reviewers / remove_reviewers (reviewers and team_reviewers), reply (reply to a review comment, comment_id from github_get_pr comments), resolve_thread / unresolve_thread (thread_id from github_get_pr include threads). auto_merge and disable_auto_merge return {number, queued, auto_merge: {enabled, method, enabled_by?}, merge_queue: {state, position?, estimated_time_to_merge?} or {state: NOT_QUEUED}, merged, reason?}; reason says why it was not queued (conflicts, failing checks, missing reviews, draft, behind). Then poll with one github_get_pr call (it returns merged and merge_queue), or wait with github_subscribe (events merge_queue_destroyed, pr_merged, pr_auto_merge) instead of polling.",
      z.object({
        operation: z.enum(["ready", "draft", "update_branch", "auto_merge", "disable_auto_merge", "request_reviewers", "remove_reviewers", "reply", "resolve_thread", "unresolve_thread"]),
        repo: repoField,
        number: z.number().int().describe("The pull request number."),
        merge_method: z.enum(["merge", "squash", "rebase"]).optional().describe("auto_merge. Default merge."),
        reviewers: z.array(z.string()).optional().describe("request_reviewers/remove_reviewers: logins."),
        team_reviewers: z.array(z.string()).optional().describe("request_reviewers/remove_reviewers: team slugs."),
        sha: z.string().optional().describe("update_branch: refuse if the head is not this commit."),
        comment_id: z.number().int().optional().describe("reply: the review comment to reply to."),
        body: z.string().optional().describe("reply: the text."),
        thread_id: z.string().optional().describe("resolve_thread/unresolve_thread."),
      }),
      async (i, _ctx, c) => {
        const target = await c.repo(i.repo);
        const [owner, name] = target.split("/") as [string, string];
        const url = `/repos/${target}/pulls/${i.number}`;
        const nodeId = async () => (((await get(c, url)).data as any).node_id as string);
        const readPr = async () => {
          const r = await gql(c, PR_STATE_QUERY, { owner, name, number: i.number }, { actions: ["read"], repo: target });
          const node = (r.data as any)?.data?.repository?.pullRequest;
          if (!node) throw new ProxyError("http", `GitHub did not return ${target}#${i.number}.`);
          return node;
        };
        const mutate = async (field: string, input: Record<string, unknown>, action: "update_pr" | "merge" | "review", selection: string) => {
          const r = await gql(c, `mutation($input: ${field[0]!.toUpperCase()}${field.slice(1)}Input!) { ${field}(input: $input) { ${selection} } }`, { input }, { actions: [action], repo: target });
          const errors = (r.data as any)?.errors;
          if (errors?.length) throw new ProxyError("http", `GitHub refused: ${errors.map((e: any) => e.message).join("; ")}`);
          return (r.data as any)?.data?.[field];
        };
        switch (i.operation) {
          case "ready":
            return clip((await mutate("markPullRequestReadyForReview", { pullRequestId: await nodeId() }, "update_pr", "pullRequest { number isDraft }")).pullRequest);
          case "draft":
            return clip((await mutate("convertPullRequestToDraft", { pullRequestId: await nodeId() }, "update_pr", "pullRequest { number isDraft }")).pullRequest);
          case "auto_merge": {
            let pr = await readPr();
            if (!pr.merged && !pr.isInMergeQueue && !pr.mergeQueueEntry && !pr.autoMergeRequest) {
              const mq = await gql(c, REQUIRES_QUEUE_QUERY, { owner, name, branch: pr.baseRefName }, { actions: ["read"], repo: target });
              const queue = !!(mq.data as any)?.data?.repository?.mergeQueue;
              try {
                if (queue) await mutate("enqueuePullRequest", { pullRequestId: pr.id }, "merge", "mergeQueueEntry { state position }");
                else await mutate("enablePullRequestAutoMerge", { pullRequestId: pr.id, mergeMethod: MERGE_METHODS[i.merge_method ?? "merge"] }, "merge", "pullRequest { number }");
              } catch (error) {
                if (!(error instanceof ProxyError) || error.kind !== "http") throw error;
                return clip(queueResult(await readPr(), error.message));
              }
              pr = await readPr();
            }
            return clip(queueResult(pr));
          }
          case "disable_auto_merge": {
            const pr = await readPr();
            await mutate("disablePullRequestAutoMerge", { pullRequestId: pr.id }, "merge", "pullRequest { number }");
            return clip(queueResult(await readPr()));
          }
          case "update_branch":
            return clip((await write(c, "PUT", `${url}/update-branch`, "update_pr", i.sha ? { expected_head_sha: i.sha } : {})).data);
          case "request_reviewers":
          case "remove_reviewers": {
            if (!i.reviewers?.length && !i.team_reviewers?.length) throw new ProxyError("invalid", `The ${i.operation} operation needs reviewers or team_reviewers.`);
            const r = await write(c, i.operation === "request_reviewers" ? "POST" : "DELETE", `${url}/requested_reviewers`, "update_pr", { reviewers: i.reviewers ?? [], team_reviewers: i.team_reviewers ?? [] });
            return clip({ number: i.number, requested_reviewers: (r.data as any).requested_reviewers?.map((u: any) => u.login), requested_teams: (r.data as any).requested_teams?.map((t: any) => t.slug) });
          }
          case "reply": {
            const r = await write(c, "POST", `${url}/comments/${need(i.comment_id, "comment_id", "reply")}/replies`, "comment", { body: need(i.body, "body", "reply") });
            return `Reply posted: ${(r.data as any).html_url}`;
          }
          default: {
            const threadId = need(i.thread_id, "thread_id", i.operation);
            // The thread id is global: check that it belongs to this pull request before the policy decision on the repository means anything.
            const found = await gql(c, "query($id: ID!) { node(id: $id) { ... on PullRequestReviewThread { pullRequest { number repository { nameWithOwner } } } } }", { id: threadId }, { actions: ["read"], repo: target });
            const owns = (found.data as any)?.data?.node?.pullRequest;
            if (!owns || String(owns.repository?.nameWithOwner).toLowerCase() !== target.toLowerCase() || owns.number !== i.number) throw new ProxyError("invalid", `Thread ${threadId} is not a review thread of ${target}#${i.number}. Use github_get_pr with include threads to find its id.`);
            const field = i.operation === "resolve_thread" ? "resolveReviewThread" : "unresolveReviewThread";
            return clip((await mutate(field, { threadId }, "review", "thread { id isResolved }")).thread);
          }
        }
      },
    ),

    tool(
      "github_edit_comment",
      "Edit or delete a comment: an issue or pull request comment (kind=issue) or an inline review comment (kind=review). Checked as Update PR.",
      z.object({ repo: repoField, kind: z.enum(["issue", "review"]), comment_id: z.number().int(), operation: z.enum(["edit", "delete"]), body: z.string().optional().describe("edit: the new text.") }),
      async ({ repo, kind, comment_id, operation, body }, _ctx, c) => {
        const url = `/repos/${await c.repo(repo)}/${kind === "issue" ? "issues" : "pulls"}/comments/${comment_id}`;
        if (operation === "delete") {
          await write(c, "DELETE", url, "update_pr");
          return `Deleted comment ${comment_id}.`;
        }
        const r = await write(c, "PATCH", url, "update_pr", { body: need(body, "body", "edit") });
        return `Comment updated: ${(r.data as any).html_url}`;
      },
    ),
  ];

  async function defaultBranch(c: Parameters<typeof get>[0], target: string): Promise<string> {
    return ((await get(c, `/repos/${target}`)).data as any).default_branch as string;
  }
}
