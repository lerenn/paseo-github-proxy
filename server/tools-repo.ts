import { z } from "zod";
import type { AgentToolDefinition } from "@getpaseo/plugin/server";
import { ProxyError } from "./proxy";
import { clip, clipTail, encPath, need, page, pagination, repoField, served, type Call, type Kit } from "./toolkit";

/** Releases, workflow runs, labels, repository management and settings. */
export function repoTools(kit: Kit): AgentToolDefinition[] {
  const { tool, get, write, proxy } = kit;
  const release = (r: any) => ({ id: r.id, tag: r.tag_name, name: r.name, draft: r.draft, prerelease: r.prerelease, target: r.target_commitish, author: r.author?.login, published_at: r.published_at, url: r.html_url });
  const run = (r: any) => ({ id: r.id, name: r.name ?? r.display_title, workflow_id: r.workflow_id, status: r.status, conclusion: r.conclusion, branch: r.head_branch, sha: r.head_sha, event: r.event, attempt: r.run_attempt, created_at: r.created_at, url: r.html_url });
  const job = (j: any) => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion, started_at: j.started_at, completed_at: j.completed_at, steps: j.steps?.map((s: any) => ({ name: s.name, conclusion: s.conclusion })) });

  const releaseId = async (c: Call, target: string, i: { release_id?: number | undefined; tag?: string | undefined }, op: string): Promise<number> => {
    if (i.release_id) return i.release_id;
    return ((await get(c, `/repos/${target}/releases/tags/${encPath(need(i.tag, "release_id or tag", op))}`)).data as any).id as number;
  };

  return [
    tool(
      "github_releases",
      "Releases. operation: list, get (by tag, or the latest when no tag), create (tag_name, optional name, body, target, draft, prerelease, generate_notes), edit and delete (by release_id or tag), delete_asset (asset_id). Uploading or downloading asset files is not supported. Writes are checked as Manage releases.",
      z.object({
        operation: z.enum(["list", "get", "create", "edit", "delete", "delete_asset"]),
        repo: repoField,
        tag: z.string().optional().describe("get/edit/delete: the release tag."),
        release_id: z.number().int().optional(),
        asset_id: z.number().int().optional(),
        tag_name: z.string().optional().describe("create (and edit): the tag."),
        name: z.string().optional(),
        body: z.string().optional(),
        target: z.string().optional().describe("create: branch or SHA the tag is created from if it does not exist."),
        draft: z.boolean().optional(),
        prerelease: z.boolean().optional(),
        generate_notes: z.boolean().optional(),
        make_latest: z.enum(["true", "false", "legacy"]).optional(),
        ...page,
      }),
      async (i, _ctx, c) => {
        const target = await c.repo(i.repo);
        const base = `/repos/${target}/releases`;
        const fields = { ...(i.tag_name ? { tag_name: i.tag_name } : {}), ...(i.name !== undefined ? { name: i.name } : {}), ...(i.body !== undefined ? { body: i.body } : {}), ...(i.target ? { target_commitish: i.target } : {}), ...(i.draft !== undefined ? { draft: i.draft } : {}), ...(i.prerelease !== undefined ? { prerelease: i.prerelease } : {}), ...(i.make_latest ? { make_latest: i.make_latest } : {}) };
        switch (i.operation) {
          case "list": {
            const r = await get(c, base, { page: i.page, per_page: i.per_page ?? 30 });
            return clip((r.data as any[]).map(release)) + pagination(r) + served(r);
          }
          case "get": {
            const r = await get(c, i.tag ? `${base}/tags/${encPath(i.tag)}` : i.release_id ? `${base}/${i.release_id}` : `${base}/latest`);
            const d = r.data as any;
            return clip({ ...release(d), body: d.body, assets: d.assets?.map((a: any) => ({ id: a.id, name: a.name, size: a.size, downloads: a.download_count, url: a.browser_download_url })) }) + served(r);
          }
          case "create":
            return clip(release((await write(c, "POST", base, "manage_release", { ...fields, tag_name: need(i.tag_name, "tag_name", "create"), ...(i.generate_notes ? { generate_release_notes: true } : {}) })).data));
          case "edit":
            return clip(release((await write(c, "PATCH", `${base}/${await releaseId(c, target, i, "edit")}`, "manage_release", fields)).data));
          case "delete": {
            const id = await releaseId(c, target, i, "delete");
            await write(c, "DELETE", `${base}/${id}`, "manage_release");
            return `Deleted release ${id} of ${target} (its tag is kept).`;
          }
          default:
            await write(c, "DELETE", `${base}/assets/${need(i.asset_id, "asset_id", "delete_asset")}`, "manage_release");
            return `Deleted release asset ${i.asset_id}.`;
        }
      },
    ),

    tool(
      "github_actions",
      "GitHub Actions. Read: list_workflows, list_runs (filters: workflow, branch, status, event, actor, sha), get_run (with its jobs and steps), job_logs (job_id, or run_id for the failed jobs; the end of the log, tail_lines default 150), list_artifacts, list_caches. Write (checked as Manage Actions): rerun (run_id; failed_only; or job_id), cancel, dispatch (workflow, ref, inputs), enable / disable (workflow), delete_run, delete_cache (cache_id or key). Downloading artifacts is not supported.",
      z.object({
        operation: z.enum(["list_workflows", "list_runs", "get_run", "job_logs", "list_artifacts", "list_caches", "rerun", "cancel", "dispatch", "enable", "disable", "delete_run", "delete_cache"]),
        repo: repoField,
        run_id: z.number().int().optional(),
        job_id: z.number().int().optional(),
        workflow: z.string().optional().describe("Workflow id or file name (ci.yml)."),
        ref: z.string().optional().describe("dispatch: branch or tag. list_caches: ref filter."),
        inputs: z.record(z.string(), z.string()).optional().describe("dispatch: workflow inputs."),
        branch: z.string().optional(),
        status: z.string().optional().describe("list_runs: queued, in_progress, completed, success, failure, cancelled…"),
        event: z.string().optional(),
        actor: z.string().optional(),
        sha: z.string().optional(),
        failed_only: z.boolean().optional().describe("rerun: only the failed jobs."),
        tail_lines: z.number().int().min(1).max(5000).optional().describe("job_logs. Default 150."),
        cache_id: z.number().int().optional(),
        key: z.string().optional().describe("list_caches / delete_cache: the cache key."),
        ...page,
      }),
      async (i, _ctx, c) => {
        const target = await c.repo(i.repo);
        const base = `/repos/${target}/actions`;
        const runUrl = () => `${base}/runs/${need(i.run_id, "run_id", i.operation)}`;
        const workflow = () => encodeURIComponent(need(i.workflow, "workflow", i.operation));
        const pg = { page: i.page, per_page: i.per_page ?? 30 };
        switch (i.operation) {
          case "list_workflows": {
            const r = await get(c, `${base}/workflows`, pg);
            return clip(((r.data as any).workflows as any[]).map((w) => ({ id: w.id, name: w.name, path: w.path, state: w.state }))) + pagination(r) + served(r);
          }
          case "list_runs": {
            const r = await get(c, i.workflow ? `${base}/workflows/${workflow()}/runs` : `${base}/runs`, { branch: i.branch, status: i.status, event: i.event, actor: i.actor, head_sha: i.sha, ...pg });
            return clip({ total_count: (r.data as any).total_count, runs: ((r.data as any).workflow_runs as any[]).map(run) }) + pagination(r) + served(r);
          }
          case "get_run": {
            const r = await get(c, runUrl());
            const jobs = await get(c, `${runUrl()}/jobs`, { per_page: 100 });
            return clip({ ...run(r.data), jobs: ((jobs.data as any).jobs as any[]).map(job) }) + served(r);
          }
          case "job_logs": {
            const lines = i.tail_lines ?? 150;
            if (i.job_id) return clipTail(String((await get(c, `${base}/jobs/${i.job_id}/logs`)).data ?? ""), lines);
            const jobs = (((await get(c, `${runUrl()}/jobs`, { per_page: 100 })).data as any).jobs as any[]).filter((j) => j.conclusion === "failure" || j.conclusion === "timed_out");
            if (jobs.length === 0) throw new ProxyError("invalid", "That run has no failed job. Pass job_id for the log of a specific job (see get_run).");
            const parts: string[] = [];
            for (const j of jobs.slice(0, 3)) parts.push(`=== job ${j.id}: ${j.name} (${j.conclusion}) ===\n${clipTail(String((await get(c, `${base}/jobs/${j.id}/logs`)).data ?? ""), lines)}`);
            return parts.join("\n\n") + (jobs.length > 3 ? `\n\n(${jobs.length - 3} more failed jobs: pass job_id)` : "");
          }
          case "list_artifacts": {
            const r = await get(c, i.run_id ? `${runUrl()}/artifacts` : `${base}/artifacts`, pg);
            return clip(((r.data as any).artifacts as any[]).map((a) => ({ id: a.id, name: a.name, size: a.size_in_bytes, expired: a.expired, created_at: a.created_at }))) + pagination(r) + served(r);
          }
          case "list_caches": {
            const r = await get(c, `${base}/caches`, { key: i.key, ref: i.ref, ...pg });
            return clip({ total_count: (r.data as any).total_count, caches: ((r.data as any).actions_caches as any[]).map((k) => ({ id: k.id, key: k.key, ref: k.ref, size: k.size_in_bytes, last_accessed_at: k.last_accessed_at })) }) + pagination(r) + served(r);
          }
          case "rerun": {
            const url = i.job_id ? `${base}/jobs/${i.job_id}/rerun` : `${runUrl()}/${i.failed_only ? "rerun-failed-jobs" : "rerun"}`;
            await write(c, "POST", url, "manage_actions", {});
            return i.job_id ? `Re-running job ${i.job_id}.` : `Re-running ${i.failed_only ? "the failed jobs of " : ""}run ${i.run_id}.`;
          }
          case "cancel":
            await write(c, "POST", `${runUrl()}/cancel`, "manage_actions", {});
            return `Cancelling run ${i.run_id}.`;
          case "dispatch":
            await write(c, "POST", `${base}/workflows/${workflow()}/dispatches`, "manage_actions", { ref: need(i.ref, "ref", "dispatch"), ...(i.inputs ? { inputs: i.inputs } : {}) });
            return `Dispatched ${i.workflow} on ${i.ref}. Use list_runs (event=workflow_dispatch) to follow it.`;
          case "enable":
          case "disable":
            await write(c, "PUT", `${base}/workflows/${workflow()}/${i.operation}`, "manage_actions", {});
            return `Workflow ${i.workflow} ${i.operation}d.`;
          case "delete_run":
            await write(c, "DELETE", runUrl(), "manage_actions");
            return `Deleted run ${i.run_id}.`;
          default:
            if (i.cache_id) await write(c, "DELETE", `${base}/caches/${i.cache_id}`, "manage_actions");
            else await write(c, "DELETE", `${base}/caches`, "manage_actions", undefined, { key: need(i.key, "cache_id or key", "delete_cache") });
            return "Deleted the cache.";
        }
      },
    ),

    tool(
      "github_labels",
      "Repository labels. operation: list, get, create (name, color hex without #, description), edit (name, optionally new_name, color, description), delete (name). Writes are checked as Manage labels. To put labels on an issue or PR use github_update_issue.",
      z.object({ operation: z.enum(["list", "get", "create", "edit", "delete"]), repo: repoField, name: z.string().optional(), new_name: z.string().optional(), color: z.string().optional(), description: z.string().optional(), ...page }),
      async (i, _ctx, c) => {
        const target = await c.repo(i.repo);
        const label = (l: any) => ({ name: l.name, color: l.color, description: l.description, default: l.default });
        const one = () => `/repos/${target}/labels/${encodeURIComponent(need(i.name, "name", i.operation))}`;
        if (i.operation === "list") {
          const r = await get(c, `/repos/${target}/labels`, { page: i.page, per_page: i.per_page ?? 100 });
          return clip((r.data as any[]).map(label)) + pagination(r) + served(r);
        }
        if (i.operation === "get") return clip(label((await get(c, one())).data));
        if (i.operation === "delete") {
          await write(c, "DELETE", one(), "manage_labels");
          return `Deleted label ${i.name}.`;
        }
        const fields = { ...(i.color ? { color: i.color.replace(/^#/, "") } : {}), ...(i.description !== undefined ? { description: i.description } : {}) };
        if (i.operation === "create") return clip(label((await write(c, "POST", `/repos/${target}/labels`, "manage_labels", { name: need(i.name, "name", "create"), ...fields })).data));
        return clip(label((await write(c, "PATCH", one(), "manage_labels", { ...fields, ...(i.new_name ? { new_name: i.new_name } : {}) })).data));
      },
    ),

    tool(
      "github_repo_manage",
      "Create and change repositories. operation: create (name; owner for an organization, otherwise your account; description, private, auto_init, gitignore_template, license_template), fork (of repo; optional organization, name, default_branch_only), edit (description, homepage, topics, default_branch), sync_fork (update branch of a fork from its upstream). Renaming, changing visibility, archiving and deleting are not offered: ask the user. Checked as Create repository, Edit repository or Merge.",
      z.object({
        operation: z.enum(["create", "fork", "edit", "sync_fork"]),
        repo: repoField.describe("fork/edit/sync_fork: owner/name. Omit to use your working directory's repository."),
        name: z.string().optional().describe("create: the new repository name. fork: a different name for the fork."),
        owner: z.string().optional().describe("create: the organization to create it in (default: the authenticated user)."),
        organization: z.string().optional().describe("fork: the organization to fork into."),
        description: z.string().optional(),
        homepage: z.string().optional(),
        topics: z.array(z.string()).optional(),
        default_branch: z.string().optional(),
        private: z.boolean().optional(),
        auto_init: z.boolean().optional(),
        gitignore_template: z.string().optional(),
        license_template: z.string().optional(),
        default_branch_only: z.boolean().optional(),
        branch: z.string().optional().describe("sync_fork: the branch to update."),
      }),
      async (i, _ctx, c) => {
        const slim = (d: any) => ({ full_name: d.full_name, private: d.private, default_branch: d.default_branch, fork: d.fork, url: d.html_url, clone_url: d.clone_url });
        if (i.operation === "create") {
          const name = need(i.name, "name", "create");
          // The path of a user's repositories names no owner, so the destination is checked here.
          const verdict = i.owner ? proxy.judgeAction(`${i.owner}/${name}`, ["create_repo"]) : null;
          if (verdict && !verdict.allowed) throw new ProxyError("denied", verdict.message);
          const body = { name, ...(i.description !== undefined ? { description: i.description } : {}), ...(i.homepage ? { homepage: i.homepage } : {}), private: i.private ?? true, ...(i.auto_init ? { auto_init: true } : {}), ...(i.gitignore_template ? { gitignore_template: i.gitignore_template } : {}), ...(i.license_template ? { license_template: i.license_template } : {}) };
          return clip(slim((await write(c, "POST", i.owner ? `/orgs/${i.owner}/repos` : "/user/repos", "create_repo", body)).data));
        }
        const target = await c.repo(i.repo);
        if (i.operation === "fork") {
          if (i.organization) {
            const verdict = proxy.judgeAction(`${i.organization}/${i.name ?? target.split("/")[1]}`, ["create_repo"]);
            if (!verdict.allowed) throw new ProxyError("denied", verdict.message);
          }
          const body = { ...(i.organization ? { organization: i.organization } : {}), ...(i.name ? { name: i.name } : {}), ...(i.default_branch_only ? { default_branch_only: true } : {}) };
          return clip(slim((await write(c, "POST", `/repos/${target}/forks`, "create_repo", body)).data));
        }
        if (i.operation === "sync_fork") {
          const r = await write(c, "POST", `/repos/${target}/merge-upstream`, "merge", { branch: need(i.branch, "branch", "sync_fork") });
          return clip(r.data);
        }
        const patch = { ...(i.description !== undefined ? { description: i.description } : {}), ...(i.homepage !== undefined ? { homepage: i.homepage } : {}), ...(i.default_branch ? { default_branch: i.default_branch } : {}) };
        if (Object.keys(patch).length === 0 && !i.topics) throw new ProxyError("invalid", "Nothing to change: pass description, homepage, topics or default_branch.");
        let out: unknown = {};
        if (Object.keys(patch).length) out = slim((await write(c, "PATCH", `/repos/${target}`, "edit_repo", patch)).data);
        if (i.topics) out = { ...(out as object), topics: ((await write(c, "PUT", `/repos/${target}/topics`, "edit_repo", { names: i.topics })).data as any).names };
        return clip(out);
      },
    ),

    tool(
      "github_repo_config",
      "Repository and organization settings. Read: rulesets, ruleset (ruleset_id), branch_rules (rules that apply to a branch), branch_protection (classic protection of a branch), environments, deploy_keys (titles only), secrets (NAMES only: values are never returned by GitHub), variables (names and values). Write (checked as Manage variables and secrets): set_variable (name, value), delete_variable, delete_secret. Secret values cannot be set here. Use org for organization-level secrets and variables, environment for an environment's.",
      z.object({
        operation: z.enum(["rulesets", "ruleset", "branch_rules", "branch_protection", "environments", "deploy_keys", "secrets", "variables", "set_variable", "delete_variable", "delete_secret"]),
        repo: repoField,
        org: z.string().optional().describe("secrets/variables and their writes: the organization instead of a repository."),
        environment: z.string().optional().describe("secrets/variables and their writes: an environment of the repository."),
        ruleset_id: z.number().int().optional(),
        branch: z.string().optional(),
        name: z.string().optional().describe("The variable or secret name."),
        value: z.string().optional().describe("set_variable."),
        visibility: z.enum(["all", "private", "selected"]).optional().describe("set_variable at organization level. Default private."),
        ...page,
      }),
      async (i, _ctx, c) => {
        const pg = { page: i.page, per_page: i.per_page ?? 30 };
        const isConfig = ["secrets", "variables", "set_variable", "delete_variable", "delete_secret"].includes(i.operation);
        if (isConfig) {
          const root = i.org ? `/orgs/${i.org}/actions` : i.environment ? `/repos/${await c.repo(i.repo)}/environments/${encodeURIComponent(i.environment)}` : `/repos/${await c.repo(i.repo)}/actions`;
          const vars = `${root}/variables`;
          const secrets = `${root}/secrets`;
          if (i.operation === "secrets") {
            const r = await get(c, secrets, pg);
            return clip({ total_count: (r.data as any).total_count, secrets: ((r.data as any).secrets as any[]).map((s) => ({ name: s.name, created_at: s.created_at, updated_at: s.updated_at, visibility: s.visibility })) }) + pagination(r) + served(r);
          }
          if (i.operation === "variables") {
            const r = await get(c, vars, pg);
            return clip({ total_count: (r.data as any).total_count, variables: ((r.data as any).variables as any[]).map((v) => ({ name: v.name, value: v.value, updated_at: v.updated_at, visibility: v.visibility })) }) + pagination(r) + served(r);
          }
          const name = need(i.name, "name", i.operation);
          if (i.operation === "delete_variable") {
            await write(c, "DELETE", `${vars}/${encodeURIComponent(name)}`, "manage_variables");
            return `Deleted variable ${name}.`;
          }
          if (i.operation === "delete_secret") {
            await write(c, "DELETE", `${secrets}/${encodeURIComponent(name)}`, "manage_variables");
            return `Deleted secret ${name}.`;
          }
          const body = { name, value: need(i.value, "value", "set_variable"), ...(i.org ? { visibility: i.visibility ?? "private" } : {}) };
          try {
            await write(c, "POST", vars, "manage_variables", body);
            return `Created variable ${name}.`;
          } catch (error) {
            if (!(error instanceof ProxyError) || (error.status !== 409 && error.status !== 422)) throw error;
            await write(c, "PATCH", `${vars}/${encodeURIComponent(name)}`, "manage_variables", { name, value: body.value, ...(i.org ? { visibility: body.visibility } : {}) });
            return `Updated variable ${name}.`;
          }
        }
        const target = await c.repo(i.repo);
        switch (i.operation) {
          case "rulesets": {
            const r = await get(c, `/repos/${target}/rulesets`, pg);
            return clip((r.data as any[]).map((x) => ({ id: x.id, name: x.name, target: x.target, enforcement: x.enforcement, source: x.source }))) + pagination(r) + served(r);
          }
          case "ruleset":
            return clip((await get(c, `/repos/${target}/rulesets/${need(i.ruleset_id, "ruleset_id", "ruleset")}`)).data);
          case "branch_rules":
            return clip((await get(c, `/repos/${target}/rules/branches/${encPath(need(i.branch, "branch", "branch_rules"))}`, pg)).data);
          case "branch_protection":
            return clip((await get(c, `/repos/${target}/branches/${encPath(need(i.branch, "branch", "branch_protection"))}/protection`)).data);
          case "environments": {
            const r = await get(c, `/repos/${target}/environments`, pg);
            return clip(((r.data as any).environments as any[]).map((e) => ({ name: e.name, protection_rules: e.protection_rules?.map((p: any) => p.type), updated_at: e.updated_at }))) + served(r);
          }
          default: {
            const r = await get(c, `/repos/${target}/keys`, pg);
            return clip((r.data as any[]).map((k) => ({ id: k.id, title: k.title, read_only: k.read_only, created_at: k.created_at }))) + pagination(r) + served(r);
          }
        }
      },
    ),
  ];
}
