import { describe, expect, it } from "vitest";
import { applyLockout, CAPABILITY_ENV, isGithubMcp, SERVER_NAME, URL_ENV } from "./lockout";
import { PREAPPROVED_TOOL_NAMES } from "./tools";

const opts = { url: "http://127.0.0.1:47821", capability: "cap", binDir: "/bin-shim", emptyGhConfigDir: "/empty", inheritedPath: "/usr/bin" };
const base = (over: object = {}) => ({ config: { provider: "claude", cwd: "/work" }, ...over }) as Parameters<typeof applyLockout>[0];

describe("applyLockout", () => {
  it("empties GitHub credentials, even ones passed explicitly", () => {
    const out = applyLockout(base({ env: { GH_TOKEN: "x", GITHUB_TOKEN: "y", GITHUB_PAT: "z", GH_ENTERPRISE_TOKEN: "e", KEEP: "1" } }), opts)!;
    expect(out.env).toMatchObject({ GH_TOKEN: "", GITHUB_TOKEN: "", GITHUB_PAT: "", GH_ENTERPRISE_TOKEN: "", GITHUB_ENTERPRISE_TOKEN: "", KEEP: "1" });
  });

  it("still empties inherited credentials when the request sets no env", () => {
    const out = applyLockout(base(), opts)!;
    expect(out.env).toMatchObject({ GH_TOKEN: "", GITHUB_TOKEN: "" });
  });

  it("shadows gh on PATH and points the real gh at an empty config", () => {
    const out = applyLockout(base(), opts)!;
    expect(out.env!.PATH).toBe("/bin-shim:/usr/bin");
    expect(out.env!.GH_CONFIG_DIR).toBe("/empty");
    expect(out.env![URL_ENV]).toBe(opts.url);
    expect(out.env![CAPABILITY_ENV]).toBe("cap");
    expect(applyLockout(base({ env: { PATH: "/custom" } }), opts)!.env!.PATH).toBe("/bin-shim:/custom");
  });

  it("removes GitHub MCP servers by name, url and command, keeps the others", () => {
    const out = applyLockout(
      base({
        config: {
          provider: "claude", cwd: "/w",
          mcpServers: {
            github: { type: "http", url: "https://example.com/mcp" },
            copilot: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
            gh2: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
            docs: { type: "http", url: "https://docs.example.com/mcp" },
            db: { type: "stdio", command: "db-mcp", env: { GITHUB_TOKEN: "leak", DB: "x" } },
          },
          toolPolicy: { preapproved: [{ kind: "mcp", server: "github", tool: "x" }, { kind: "mcp", server: "docs", tool: "y" }] },
        },
      }),
      opts,
    )!;
    expect(Object.keys(out.config.mcpServers!).sort()).toEqual(["db", "docs", SERVER_NAME]);
    expect((out.config.mcpServers!.db as { env: object }).env).toEqual({ GITHUB_TOKEN: "", DB: "x" });
    expect(out.config.toolPolicy!.preapproved.filter((t) => t.server === "github")).toEqual([]);
    expect(out.config.toolPolicy!.preapproved).toContainEqual({ kind: "mcp", server: "docs", tool: "y" });
  });

  it("injects the proxy MCP server with the capability and preapproves the read tools", () => {
    const out = applyLockout(base(), opts)!;
    expect(out.config.mcpServers![SERVER_NAME]).toMatchObject({ type: "http", url: "http://127.0.0.1:47821/mcp", headers: { authorization: "Bearer cap" } });
    expect(out.config.toolPolicy!.preapproved.map((t) => t.tool)).toEqual(PREAPPROVED_TOOL_NAMES);
    expect(out.config.systemPrompt).toContain("no GitHub token");
  });

  it("appends to an existing system prompt", () => {
    expect(applyLockout(base({ config: { provider: "claude", cwd: "/w", systemPrompt: "Be brief." } }), opts)!.config.systemPrompt).toMatch(/^Be brief\.\n\nGitHub access/);
  });

  it("leaves the request alone when the agent opted out", () => {
    for (const v of ["off", "OFF", "0", "false"]) {
      expect(applyLockout(base({ env: { PASEO_GITHUB_PROXY: v, GH_TOKEN: "mine" } }), opts)).toBeUndefined();
    }
  });

  it("does not treat its own server as a GitHub MCP", () => {
    expect(isGithubMcp(SERVER_NAME, { type: "http", url: "http://127.0.0.1/mcp" })).toBe(false);
  });
});
