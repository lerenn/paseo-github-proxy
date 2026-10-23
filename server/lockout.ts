import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import { PROXY_ENV, lockoutApplies, type LockoutScope } from "../shared/plugin";
import { PREAPPROVED_TOOL_NAMES } from "./tools";

type CreateRequest = PluginBeforeRequests["agent.create"];
type McpServers = NonNullable<CreateRequest["config"]["mcpServers"]>;

export const SERVER_NAME = "github-proxy";
export const URL_ENV = "PASEO_GITHUB_PROXY_URL";
export const CAPABILITY_ENV = "PASEO_GITHUB_PROXY_CAPABILITY";

/** Environment variables that carry GitHub credentials. Emptied so inherited values are overridden. */
const CREDENTIAL_ENV = /^(GH|GITHUB)_(ENTERPRISE_)?(TOKEN|PAT)$|^GITHUB_.*TOKEN$|^GH_.*TOKEN$/i;

export interface LockoutOptions {
  /** Base URL of the local proxy endpoint, no trailing slash. */
  url: string;
  /** Capability token minted for this agent. */
  capability: string;
  /** Directory holding the `gh` shim; goes first on PATH. */
  binDir: string;
  /** Empty directory used as GH_CONFIG_DIR so the real `gh` finds no stored login. */
  emptyGhConfigDir: string;
  /** PATH to extend when the request does not set one. */
  inheritedPath?: string;
  /** Which agents are locked out. Defaults to every agent that did not opt out. */
  scope?: LockoutScope;
}

/** True for an MCP server that gives GitHub access (by name, URL, or launch command). */
export function isGithubMcp(name: string, server: McpServers[string]): boolean {
  if (name === SERVER_NAME) return false;
  if (/github/i.test(name)) return true;
  if (server.type === "stdio") return /github/i.test([server.command, ...(server.args ?? [])].join(" "));
  return /github/i.test(server.url);
}

/**
 * Lockout by default: remove GitHub credentials and GitHub MCP servers from the new agent, shadow
 * `gh` with the proxy shim, and give the agent the proxy's MCP tools. Returns undefined (no change)
 * when the scope does not cover the agent (opted out with PASEO_GITHUB_PROXY=off, or not opted in under `opt-in`).
 */
export function applyLockout(request: CreateRequest, o: LockoutOptions): CreateRequest | undefined {
  if (!lockoutApplies(o.scope ?? "all", request.env)) return undefined;

  const mcpServers: McpServers = {};
  const removed = new Set<string>();
  for (const [name, server] of Object.entries(request.config.mcpServers ?? {})) {
    if (isGithubMcp(name, server)) {
      removed.add(name);
      continue;
    }
    mcpServers[name] = server.type === "stdio" && server.env ? { ...server, env: scrubEnv(server.env) } : server;
  }
  mcpServers[SERVER_NAME] = {
    type: "http",
    url: `${o.url}/mcp`,
    headers: { authorization: `Bearer ${o.capability}` },
    alwaysLoad: true,
  };

  const preapproved = (request.config.toolPolicy?.preapproved ?? []).filter((t) => !removed.has(t.server));
  const note =
    "GitHub access: you have no GitHub token. Read and write GitHub through the github-proxy MCP tools, or use `gh` for reads " +
    "(gh pr view, gh pr checks, gh api). Git clone and push keep working over SSH.";

  const env = {
    ...scrubEnv(request.env ?? {}),
    ...Object.fromEntries(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].map((k) => [k, ""])),
    GH_CONFIG_DIR: o.emptyGhConfigDir,
    GH_PROMPT_DISABLED: "1",
    PATH: `${o.binDir}:${request.env?.PATH ?? o.inheritedPath ?? "/usr/local/bin:/usr/bin:/bin"}`,
    [URL_ENV]: o.url,
    [CAPABILITY_ENV]: o.capability,
  };

  return {
    ...request,
    config: {
      ...request.config,
      systemPrompt: [request.config.systemPrompt, note].filter(Boolean).join("\n\n"),
      mcpServers,
      toolPolicy: { preapproved: [...preapproved, ...PREAPPROVED_TOOL_NAMES.map((tool) => ({ kind: "mcp" as const, server: SERVER_NAME, tool }))] },
    },
    env,
  };
}

function scrubEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, CREDENTIAL_ENV.test(k) && k !== PROXY_ENV ? "" : v]));
}
