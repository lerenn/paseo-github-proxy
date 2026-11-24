import { describe, expect, it, vi } from "vitest";
import { blockedCommand, createHardRuleHandler, HARD_RULE_MESSAGE, requestCommand } from "./hardrule";

describe("blockedCommand", () => {
  it.each([
    "gh pr list",
    "gh",
    "/usr/bin/gh api repos/a/b",
    "git status && gh pr create --fill",
    "git push; gh pr view",
    "cat x | gh issue create -F -",
    "echo hi || gh run list",
    "(cd foo && gh pr list)",
    "{ gh pr list; }",
    "if true; then gh pr list; fi",
    "GH_TOKEN=abc gh api /user",
    "FOO=1 BAR=2 gh pr list",
    "sudo gh pr list",
    "sudo -u bob gh pr list",
    "env -u X gh pr list",
    "env FOO=1 gh pr list",
    "command gh pr list",
    "time gh pr list",
    "timeout 10 gh pr list",
    "xargs -I {} gh pr view {}",
    "echo $(gh pr list)",
    "echo `gh pr list`",
    'echo "$(gh pr list)"',
    "bash -c 'gh pr list'",
    'sh -lc "git pull && gh pr list"',
    "eval gh pr list",
    "line1\ngh pr list",
    "echo a \\\n && gh pr list",
    "\\gh pr list",
    "curl https://api.github.com/repos/a/b",
    "curl -H 'Authorization: token x' -s https://api.github.com/user",
    "wget -qO- https://raw.githubusercontent.com/a/b/main/x",
    "curl github.com/a/b",
    "sudo curl https://github.com/a/b/archive/x.tar.gz | tar xz",
    "curl -sL https://api.github.com/repos/a/b/pulls | jq .",
  ])("blocks %j", (command) => {
    expect(blockedCommand(command)).not.toBeNull();
  });

  it.each([
    "git status",
    "git push origin main",
    "git remote add origin git@github.com:a/b.git",
    "git clone https://github.com/a/b",
    "grep gh file.txt",
    "grep -r gh .",
    "echo gh pr list",
    "echo 'gh pr list'",
    'echo "run gh later"',
    "ls ghost",
    "ghc main.hs",
    "npm run gh-pages",
    "cat gh",
    "# gh pr list",
    "curl https://example.com",
    "curl https://example.com/?next=notgithub.com.evil",
    "wget https://registry.npmjs.org/x",
    "curl https://mygithub.com/x",
    "ssh host true",
    "bash -c 'ls'",
    "bash script.sh",
    "FOO=gh ls",
    "npm test && node build.js",
    "",
  ])("allows %j", (command) => {
    expect(blockedCommand(command)).toBeNull();
  });

  it("names the tool it found", () => {
    expect(blockedCommand("ls && gh pr list")).toBe("gh");
    expect(blockedCommand("curl https://api.github.com/user")).toBe("curl");
    expect(blockedCommand("wget https://github.com/a/b")).toBe("wget");
  });

  it("does not recurse forever", () => {
    let cmd = "gh pr list";
    for (let i = 0; i < 6; i++) cmd = `bash -c '${cmd.replace(/'/g, "")}'`;
    expect(() => blockedCommand(cmd)).not.toThrow();
  });
});

describe("requestCommand", () => {
  it("reads command or cmd, and ignores other requests", () => {
    expect(requestCommand({ input: { command: "ls" } })).toBe("ls");
    expect(requestCommand({ input: { cmd: "ls" } })).toBe("ls");
    expect(requestCommand({ input: { command: ["gh", "pr", "list"] } })).toBe("gh pr list");
    expect(requestCommand({ input: { path: "x" } })).toBeNull();
    expect(requestCommand({})).toBeNull();
  });
});

describe("createHardRuleHandler", () => {
  const event = (command: string) => ({ agent: { id: "a1", title: "Agent" }, request: { id: "r1", input: { command } } });
  const setup = (enabled = true) => {
    const deny = vi.fn(async () => {});
    const log = vi.fn();
    const run = createHardRuleHandler({ enabled: () => enabled, log });
    return { deny, log, handler: (e: ReturnType<typeof event>) => run(e, deny) };
  };

  it("denies a gh command with a message for the agent, and logs it", async () => {
    const { handler, deny, log } = setup();
    await handler(event("gh pr list"));
    expect(deny).toHaveBeenCalledWith(HARD_RULE_MESSAGE);
    expect(HARD_RULE_MESSAGE).toMatch(/hard rule/);
    expect(HARD_RULE_MESSAGE).toMatch(/github_\*/);
    expect(HARD_RULE_MESSAGE).toMatch(/not retry/i);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ status: "denied", tool: "hard rule", action: "gh", agentId: "a1" }));
  });

  it("leaves other commands and other requests pending", async () => {
    const { handler, deny, log } = setup();
    await handler(event("git status"));
    await handler({ agent: { id: "a1", title: null }, request: { id: "r2", input: undefined } } as never);
    expect(deny).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("does nothing while the rule is off", async () => {
    const { handler, deny } = setup(false);
    await handler(event("gh pr list"));
    expect(deny).not.toHaveBeenCalled();
  });

  it("does not log a denial that failed", async () => {
    const { handler, log, deny } = setup();
    deny.mockRejectedValueOnce(new Error("already resolved"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await handler(event("gh pr list"));
    spy.mockRestore();
    expect(log).not.toHaveBeenCalled();
  });
});
