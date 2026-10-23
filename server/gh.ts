import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  PR_FIELDS, UsageError, apiGet, getChecks, getDiff, getIssue, getPull, getRepo, getRun, graphqlQuery, listIssues,
  listPulls, listRuns, ownerOfPath, parseRepo, prFields, resolveRepo, type OpsContext, type Repo,
} from "./ops";
import { GitHubError, NoTokenError } from "./github";
import { RateLimitError } from "./limiter";

export interface GhResult {
  stdout: string;
  stderr: string;
  code: number;
  /** `--jq` expression for the caller to apply to stdout (raw output, like `jq -r`). */
  jq?: string;
}

const VALUE_FLAGS = new Set(["R", "repo", "X", "method", "f", "raw-field", "F", "field", "H", "header", "jq", "q", "json", "s", "state", "L", "limit", "H", "head", "B", "base", "A", "author", "l", "label", "b", "branch", "input", "t", "template", "cache", "hostname"]);

interface Parsed {
  args: string[];
  flags: Map<string, string[]>;
}

function parse(argv: string[]): Parsed {
  const args: string[] = [];
  const flags = new Map<string, string[]>();
  const add = (k: string, v: string) => flags.set(k, [...(flags.get(k) ?? []), v]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }
    const long = a.match(/^--([\w-]+)(?:=(.*))?$/s);
    const short = !long && a.match(/^-([A-Za-z])(.*)$/s);
    if (long || short) {
      const name = long ? long[1] : (short as RegExpMatchArray)[1];
      const inline = long ? long[2] : (short as RegExpMatchArray)[2] || undefined;
      if (VALUE_FLAGS.has(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined) throw new UsageError(`flag needs an argument: ${a}`);
        add(name, value);
      } else add(name, "true");
    } else args.push(a);
  }
  return { args, flags };
}

const flag = (p: Parsed, ...names: string[]) => names.map((n) => p.flags.get(n)?.at(-1)).find((v) => v !== undefined);
const has = (p: Parsed, ...names: string[]) => names.some((n) => p.flags.has(n));
const many = (p: Parsed, ...names: string[]) => names.flatMap((n) => p.flags.get(n) ?? []);

const SUPPORTED = "gh api (GET and GraphQL queries), gh pr view|list|checks|diff, gh issue view|list, gh run list|view, gh repo view";
const WRITE_HINT = "Writes are not available through the gh shim. Use the github-proxy MCP tools (github_comment, github_pr_create, ...).";

export async function runGh(argv: string[], ctx: OpsContext): Promise<GhResult> {
  try {
    return await dispatch(argv, ctx);
  } catch (err) {
    return { stdout: "", stderr: `${message(err)}\n`, code: 1 };
  }
}

function message(err: unknown): string {
  if (err instanceof GitHubError) return `gh: ${err.message} (HTTP ${err.status})`;
  if (err instanceof NoTokenError || err instanceof UsageError || err instanceof RateLimitError) return `gh: ${err.message}`;
  return `gh: ${err instanceof Error ? err.message : String(err)}`;
}

const ok = (stdout: string, extra: Partial<GhResult> = {}): GhResult => ({ stdout, stderr: "", code: 0, ...extra });
const json = (value: unknown, jq?: string): GhResult => ok(`${JSON.stringify(value)}\n`, jq ? { jq } : {});

async function dispatch(argv: string[], ctx: OpsContext): Promise<GhResult> {
  const p = parse(argv);
  const [cmd, sub, ...rest] = p.args;
  if (has(p, "version") && !cmd) return ok("gh version 0.0.0 (paseo github-proxy shim)\n");
  if (!cmd || cmd === "help") return ok(`Paseo GitHub proxy gh shim. Supported: ${SUPPORTED}\n`);
  const jq = flag(p, "jq", "q");
  const fields = flag(p, "json")?.split(",").map((s) => s.trim()).filter(Boolean);
  const repoOf = () => resolveRepo(ctx, flag(p, "R", "repo"));

  if (["pr", "issue", "release", "repo", "label", "workflow", "run", "secret", "variable"].includes(cmd) && ["create", "comment", "merge", "edit", "close", "reopen", "review", "ready", "delete", "rerun", "cancel", "run", "set", "add", "remove"].includes(sub)) {
    throw new UsageError(WRITE_HINT);
  }

  switch (cmd) {
    case "api":
      return api(p, ctx, jq);
    case "auth":
      if (sub === "status") return ok("github.com\n  Authenticated through the Paseo GitHub proxy. No token is available to this agent.\n");
      break;
    case "pr": {
      const repo = await repoOf();
      if (sub === "view") {
        const pr = await getPull(ctx, repo, rest[0]);
        if (fields) return json(await prFields(ctx, repo, pr, fields), jq);
        const v = await prFields(ctx, repo, pr, ["number", "title", "state", "author", "labels", "url", "headRefName", "baseRefName", "isDraft", "body"]);
        return ok(
          [
            `title:\t${v.title}`, `state:\t${v.state}${v.isDraft ? " (draft)" : ""}`, `author:\t${v.author?.login ?? ""}`,
            `labels:\t${v.labels.map((l: { name: string }) => l.name).join(", ")}`, `number:\t${v.number}`,
            `branch:\t${v.headRefName} -> ${v.baseRefName}`, `url:\t${v.url}`, "--", v.body, "",
          ].join("\n"),
          jq ? { jq } : {},
        );
      }
      if (sub === "list") {
        const wanted = flag(p, "s", "state");
        const list = await listPulls(ctx, repo, {
          state: wanted === "merged" ? "closed" : (wanted as "open" | "closed" | "all" | undefined),
          head: flag(p, "head"), base: flag(p, "B", "base"), author: flag(p, "A", "author"), limit: Number(flag(p, "L", "limit") ?? 30),
        });
        if (fields) return json(await Promise.all(list.map((pr) => prFields(ctx, repo, pr, fields))), jq);
        return ok(list.map((pr) => `${pr.number}\t${pr.title}\t${pr.head.ref}\t${pr.draft ? "DRAFT" : String(pr.state).toUpperCase()}`).join("\n") + (list.length ? "\n" : ""));
      }
      if (sub === "checks") {
        const pr = await getPull(ctx, repo, rest[0]);
        const checks = await getChecks(ctx, repo, pr.head.sha);
        const code = checks.some((c) => c.bucket === "fail") ? 1 : checks.some((c) => c.bucket === "pending") ? 8 : 0;
        if (fields) {
          const out = checks.map((c) => Object.fromEntries(fields.map((f) => [f, (c as unknown as Record<string, unknown>)[f] ?? null])));
          return { ...json(out, jq), code };
        }
        const text = checks.map((c) => `${c.name}\t${c.bucket}\t${elapsed(c.startedAt, c.completedAt)}\t${c.link}\t${c.description}`).join("\n");
        return { stdout: text ? `${text}\n` : "", stderr: checks.length ? "" : "no checks reported\n", code: checks.length ? code : 1 };
      }
      if (sub === "diff") {
        const pr = await getPull(ctx, repo, rest[0]);
        return ok(await getDiff(ctx, repo, pr.number));
      }
      break;
    }
    case "issue": {
      const repo = await repoOf();
      if (sub === "view") {
        const issue = await getIssue(ctx, repo, Number(rest[0]?.replace("#", "")));
        const v = { number: issue.number, title: issue.title, state: String(issue.state).toUpperCase(), body: issue.body ?? "", url: issue.html_url, author: { login: issue.user?.login }, labels: (issue.labels ?? []).map((l: { name: string }) => ({ name: l.name })), createdAt: issue.created_at, updatedAt: issue.updated_at };
        if (fields) return json(Object.fromEntries(fields.map((f) => [f, (v as Record<string, unknown>)[f] ?? null])), jq);
        return ok([`title:\t${v.title}`, `state:\t${v.state}`, `author:\t${v.author.login}`, `labels:\t${v.labels.map((l: { name: string }) => l.name).join(", ")}`, `number:\t${v.number}`, `url:\t${v.url}`, "--", v.body, ""].join("\n"));
      }
      if (sub === "list") {
        const list = await listIssues(ctx, repo, { state: flag(p, "s", "state"), labels: many(p, "l", "label").join(","), limit: Number(flag(p, "L", "limit") ?? 30) });
        if (fields) return json(list.map((i) => Object.fromEntries(fields.map((f) => [f, ({ number: i.number, title: i.title, state: String(i.state).toUpperCase(), url: i.html_url, body: i.body } as Record<string, unknown>)[f] ?? null]))), jq);
        return ok(list.map((i) => `${i.number}\t${String(i.state).toUpperCase()}\t${i.title}`).join("\n") + (list.length ? "\n" : ""));
      }
      break;
    }
    case "run": {
      const repo = await repoOf();
      if (sub === "list") {
        const runs = await listRuns(ctx, repo, { branch: flag(p, "b", "branch"), limit: Number(flag(p, "L", "limit") ?? 20) });
        if (fields) return json(runs.map((r) => Object.fromEntries(fields.map((f) => [f, runField(r, f)]))), jq);
        return ok(runs.map((r) => `${r.status === "completed" ? r.conclusion : r.status}\t${r.display_title}\t${r.name}\t${r.head_branch}\t${r.event}\t${r.id}`).join("\n") + (runs.length ? "\n" : ""));
      }
      if (sub === "view") {
        if (has(p, "log", "log-failed")) throw new UsageError("Run logs are not available through the gh shim.");
        const { run, jobs } = await getRun(ctx, repo, Number(rest[0]));
        if (fields) return json({ ...Object.fromEntries(fields.map((f) => [f, runField(run, f)])), ...(fields.includes("jobs") ? { jobs: jobs.map((j) => ({ name: j.name, status: j.status, conclusion: j.conclusion, url: j.html_url })) } : {}) }, jq);
        return ok([`${run.name} ${run.display_title} #${run.run_number}`, `status:\t${run.status}`, `conclusion:\t${run.conclusion ?? ""}`, `url:\t${run.html_url}`, "JOBS", ...jobs.map((j) => `${j.conclusion ?? j.status}\t${j.name}`), ""].join("\n"));
      }
      break;
    }
    case "repo":
      if (sub === "view") {
        const repo = rest[0] ? ((parseRepo(rest[0]) as Repo | null) ?? (await repoOf())) : await repoOf();
        const r = await getRepo(ctx, repo);
        const v: Record<string, unknown> = { name: r.name, nameWithOwner: r.full_name, description: r.description, url: r.html_url, defaultBranchRef: { name: r.default_branch }, isPrivate: r.private, isArchived: r.archived };
        if (fields) return json(Object.fromEntries(fields.map((f) => [f, v[f] ?? null])), jq);
        return ok(`name:\t${r.full_name}\ndescription:\t${r.description ?? ""}\ndefault branch:\t${r.default_branch}\nurl:\t${r.html_url}\n`);
      }
      break;
  }
  throw new UsageError(`"gh ${[cmd, sub].filter(Boolean).join(" ")}" is not supported by the GitHub proxy shim. Supported: ${SUPPORTED}. For anything else use the github_api MCP tool.`);
}

async function api(p: Parsed, ctx: OpsContext, jq?: string): Promise<GhResult> {
  const endpoint = p.args[1];
  if (!endpoint) throw new UsageError("gh api: endpoint required");
  const fieldArgs = [...many(p, "f", "raw-field").map((v) => [v, false] as const), ...many(p, "F", "field").map((v) => [v, true] as const)];
  const explicit = flag(p, "X", "method")?.toUpperCase();
  const method = explicit ?? (fieldArgs.length ? "POST" : "GET");
  const isGraphql = endpoint === "graphql" || endpoint === "/graphql";
  if (has(p, "input")) throw new UsageError("gh api --input is not supported by the shim.");
  if (!isGraphql && method !== "GET") throw new UsageError(WRITE_HINT);

  const fields: Record<string, unknown> = {};
  for (const [raw, typed] of fieldArgs) {
    const i = raw.indexOf("=");
    if (i < 0) throw new UsageError(`invalid field format: ${raw}`);
    fields[raw.slice(0, i)] = typed ? await typedValue(raw.slice(i + 1), ctx.cwd) : raw.slice(i + 1);
  }

  const repo = await resolveRepo(ctx, flag(p, "R", "repo")).catch(() => null);
  if (isGraphql) {
    const { query, ...variables } = fields;
    if (typeof query !== "string") throw new UsageError("gh api graphql: -f query=... is required");
    const owner = (variables.owner as string | undefined) ?? repo?.owner;
    if (!owner) throw new UsageError("gh api graphql: cannot tell which owner's token to use. Run from a repository checkout or pass -R owner/repo.");
    const data = await graphqlQuery(ctx, owner, query, variables);
    return json({ data }, jq);
  }

  let pathName = endpoint.replace(/\{owner\}/g, repo?.owner ?? "{owner}").replace(/\{repo\}/g, repo?.repo ?? "{repo}");
  if (pathName.includes("{")) throw new UsageError("gh api: {owner}/{repo} placeholders need a repository. Pass -R owner/repo.");
  if (!pathName.startsWith("/")) pathName = `/${pathName}`;
  if (Object.keys(fields).length) {
    const q = new URLSearchParams(Object.entries(fields).map(([k, v]): [string, string] => [k, String(v)]));
    pathName += `${pathName.includes("?") ? "&" : "?"}${q}`;
  }
  const accept = many(p, "H", "header").map((h) => h.match(/^accept:\s*(.+)$/i)?.[1]).find(Boolean);
  const data = accept
    ? (await ctx.client.rest({ owner: ownerOfPath(pathName, repo?.owner), path: pathName, accept, priority: ctx.priority })).data
    : await apiGet(ctx, ownerOfPath(pathName, repo?.owner), pathName, has(p, "paginate"));
  return typeof data === "string" ? ok(data.endsWith("\n") ? data : `${data}\n`) : json(data, jq);
}

async function typedValue(v: string, cwd?: string): Promise<unknown> {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v.startsWith("@")) return readFile(path.resolve(cwd ?? ".", v.slice(1)), "utf8");
  return v;
}

function runField(r: Record<string, any>, f: string): unknown {
  const map: Record<string, unknown> = {
    databaseId: r.id, name: r.name, displayTitle: r.display_title, status: r.status, conclusion: r.conclusion ?? "", headBranch: r.head_branch,
    headSha: r.head_sha, event: r.event, url: r.html_url, createdAt: r.created_at, updatedAt: r.updated_at, workflowName: r.name, number: r.run_number,
  };
  return map[f] ?? null;
}

function elapsed(start: string | null, end: string | null): string {
  if (!start || !end) return "0";
  const s = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

export { PR_FIELDS };
