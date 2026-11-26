import { execFile } from "node:child_process";
import { z } from "zod";
import { defineAgentTool, type AgentToolContext, type AgentToolDefinition, type AgentToolResult } from "@getpaseo/plugin/server";
import type { Action } from "../shared/actions";
import type { SubscriptionStore } from "./subscriptions";
import { PathError, parseRepo } from "./path";
import { ProxyError, type CallContext, type GithubProxy, type ProxyResponse } from "./proxy";

/** Helpers shared by every group of agent tools (tools.ts and the tools-*.ts files). */

/** Runs a validator and turns its refusal into the tool error the agent reads. */
export function guard<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof PathError) throw new ProxyError("denied", error.message);
    throw error;
  }
}

export const MAX_CHARS = 40_000;

export const repoField = z.string().optional().describe("owner/name. Omit to use the repository of your working directory.");
export const page = { page: z.number().int().min(1).optional(), per_page: z.number().int().min(1).max(100).optional().describe("Default 30.") };

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
  /** The agent's subscriptions (github_subscribe). */
  subscriptions?: SubscriptionStore;
  /** Told the Paseo SDK handle of every tool call, for the webhook wake-ups. */
  onContext?: (paseo: AgentToolContext["paseo"]) => void;
  /** Where to find the origin of a working directory; replaceable in tests. */
  remoteOf?: (cwd: string) => Promise<string>;
}

export function clip(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n… truncated (${text.length - MAX_CHARS} more characters). Narrow the request or use page/per_page.` : text;
}

/** Keeps the start of a long text (a diff, a file). */
export function clipText(text: string, max = MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n… truncated (${text.length - max} more characters).` : text;
}

/** Keeps the end of a long text (a log fails at its end). */
export function clipTail(text: string, lines?: number): string {
  let out = lines ? text.split("\n").slice(-lines).join("\n") : text;
  if (out.length > MAX_CHARS) out = `… truncated (${out.length - MAX_CHARS} earlier characters). Pass a smaller tail_lines for the end only.\n${out.slice(out.length - MAX_CHARS)}`;
  return out;
}

export function pagination(r: ProxyResponse): string {
  const next = r.link && /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="next"/.exec(r.link);
  return next ? `\n(more results: request page ${next[1]})` : "";
}

export const served = (r: ProxyResponse): string => (r.served === "stale" ? "\n(note: served from an older cache entry because GitHub is rate limiting; it may be out of date)" : "");

/** Encodes each segment of a slash separated name (a branch or a file path). */
export const encPath = (value: string): string => value.split("/").map(encodeURIComponent).join("/");

/** A required input of one operation. */
export function need<T>(value: T | undefined | null, name: string, operation?: string): T {
  if (value === undefined || value === null || value === "") throw new ProxyError("invalid", `${operation ? `The ${operation} operation` : "This call"} needs ${name}.`);
  return value;
}

export interface Call {
  ctx: CallContext;
  repo(given: string | undefined): Promise<string>;
}

export type Query = Record<string, string | number | undefined>;

export interface Kit {
  proxy: GithubProxy;
  subscriptions?: SubscriptionStore;
  tool<S extends z.ZodType>(name: string, description: string, input: S, run: (input: z.output<S>, ctx: AgentToolContext, call: Call) => Promise<string>): AgentToolDefinition;
  /** A cacheable read (action: read). */
  get(c: Call, path: string, query?: Query, accept?: string): Promise<ProxyResponse>;
  /** A write whose action the tool states. */
  write(c: Call, method: string, path: string, action: Action, body?: unknown, query?: Query): Promise<ProxyResponse>;
  /** A GraphQL call of a curated tool: its document is fixed in code, the tool states the actions. */
  gql(c: Call, query: string, variables: Record<string, unknown>, o: { actions: Action[]; repo?: string; owner?: string }): Promise<ProxyResponse>;
}

/** Builds the helpers; the description of every tool reflects the soft rule at that moment. */
export function createKit(deps: ToolsDeps): Kit {
  const { proxy } = deps;
  const remoteOf = deps.remoteOf ?? gitRemote;
  const suffix = deps.softRule ? " Use this instead of the gh CLI or curl." : "";

  const makeCall = (ctx: AgentToolContext, name: string): Call => ({
    ctx: { agentId: ctx.agent.id, agentTitle: ctx.agent.title ?? ctx.agent.id, tool: name },
    async repo(given) {
      const value = (given ?? "").trim() || repoFromRemote(await remoteOf(ctx.agent.cwd));
      if (!value.includes("/") && !/\s/.test(value)) throw new ProxyError("invalid", "Pass repo as owner/name (it could not be inferred from the working directory).");
      return guard(() => parseRepo(value).full);
    },
  });

  return {
    proxy,
    ...(deps.subscriptions ? { subscriptions: deps.subscriptions } : {}),
    tool(name, description, input, run) {
      return defineAgentTool({
        name,
        description: description + suffix,
        input,
        async execute(args, ctx): Promise<AgentToolResult> {
          try {
            deps.onContext?.(ctx.paseo);
            return { text: await run(args, ctx, makeCall(ctx, name)) };
          } catch (error) {
            if (error instanceof ProxyError) return { isError: true, text: error.message };
            return { isError: true, text: `${name} failed: ${(error as Error).message}` };
          }
        },
      });
    },
    get: (c, path, query, accept) => proxy.rest(c.ctx, { method: "GET", path, ...(query ? { query } : {}), ...(accept ? { accept } : {}), actions: ["read"] }),
    write: (c, method, path, action, body, query) => proxy.rest(c.ctx, { method, path, ...(body !== undefined ? { body } : {}), ...(query ? { query } : {}), actions: [action] }),
    gql: (c, query, variables, o) => proxy.graphql(c.ctx, { query, variables, ...(o.repo ? { repo: o.repo } : {}), ...(o.owner ? { owner: o.owner } : {}), actions: o.actions }),
  };
}

/** Slim views of a pull request and an issue. */
export const pr = (p: Record<string, any>) => ({
  number: p.number, title: p.title, state: p.merged_at ? "merged" : p.state, draft: p.draft, author: p.user?.login, head: p.head?.ref, base: p.base?.ref,
  updated_at: p.updated_at, url: p.html_url, mergeable_state: p.mergeable_state, labels: p.labels?.map((l: any) => l.name),
});
export const issue = (i: Record<string, any>) => ({
  number: i.number, title: i.title, state: i.state, author: i.user?.login, labels: i.labels?.map((l: any) => l.name), assignees: i.assignees?.map((a: any) => a.login),
  comments: i.comments, updated_at: i.updated_at, url: i.html_url, is_pull_request: !!i.pull_request,
});

