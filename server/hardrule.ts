import type { ActivityEntry } from "../shared/state";

/** Shown to the agent when the hard rule refuses a command. */
export const HARD_RULE_MESSAGE =
  "Denied by the GitHub proxy plugin's hard rule (Block gh/curl commands): this command runs gh, or curl/wget against GitHub. " +
  "Use the github_* tools instead (github_api for anything without a curated tool). Do not retry this command or another way around it with gh, curl or wget; if a github_* tool denies a call, report that to the user and stop.";

const OPERATORS = new Set(["|", "&", ";", "\n", "(", ")", "`"]);
/** Words that precede a command without being one. */
const PREFIXES = new Set(["{", "}", "!", "if", "then", "else", "elif", "while", "until", "do", "time", "command", "builtin", "exec", "nohup", "sudo", "doas", "env", "nice", "ionice", "stdbuf", "timeout", "xargs", "setsid", "watch"]);
/** Options of a prefix command that take a separate value. */
const VALUE_FLAGS: Record<string, string[]> = {
  sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U"],
  doas: ["-u", "-C"],
  env: ["-u", "-C", "-S"],
  nice: ["-n"],
  ionice: ["-c", "-n", "-p"],
  stdbuf: ["-i", "-o", "-e"],
  timeout: ["-s", "-k"],
  xargs: ["-I", "-n", "-P", "-d", "-L", "-s", "-E", "-a"],
  watch: ["-n", "-d"],
};
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "fish"]);
const GITHUB_HOST = /(?:^|[^a-z0-9-])(?:[a-z0-9-]+\.)*(?:github\.com|githubusercontent\.com|githubapp\.com)(?![a-z0-9-])/i;

/** Splits a command line into simple commands, each a list of unquoted words. Quoted text stays one word. */
function split(text: string): { commands: string[][]; nested: string[] } {
  const commands: string[][] = [];
  const nested: string[] = [];
  let words: string[] = [];
  let word = "";
  let has = false;
  const endWord = () => {
    if (has) words.push(word);
    word = "";
    has = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      // An escaped newline continues the line; anything else is literal.
      if (text[i + 1] === "\n") i++;
      else if (i + 1 < text.length) {
        word += text[++i];
        has = true;
      }
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end === -1 ? text.length : end;
      word += text.slice(i + 1, stop);
      has = true;
      i = stop;
    } else if (c === '"') {
      let j = i + 1;
      let inner = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\" && j + 1 < text.length) j++;
        inner += text[j++];
      }
      // Substitutions inside double quotes still run.
      for (const m of inner.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)) nested.push(m[1] ?? m[2] ?? "");
      word += inner;
      has = true;
      i = j;
    } else if (c === "#" && !has) {
      while (i < text.length && text[i] !== "\n") i++;
      endCommand();
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
    } else if (c === "$" && text[i + 1] === "(") {
      endCommand();
      i++;
    } else if (OPERATORS.has(c)) {
      endCommand();
    } else {
      word += c;
      has = true;
    }
  }
  endCommand();
  return { commands, nested };
}

const base = (word: string): string => word.replace(/\\/g, "").split("/").pop()!.toLowerCase();

/** Which blocked tool one simple command runs, or null. */
function blocked(words: string[], depth: number): string | null {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    const name = base(w);
    if (!PREFIXES.has(name)) break;
    i++;
    const valueFlags = VALUE_FLAGS[name] ?? [];
    while (i < words.length && words[i]!.startsWith("-")) i += valueFlags.includes(words[i]!) ? 2 : 1;
    if (name === "timeout") i++; // the duration
  }
  const cmd = words[i] ? base(words[i]!) : "";
  const args = words.slice(i + 1);
  if (cmd === "gh") return "gh";
  if (cmd === "curl" || cmd === "wget") return args.some((a) => GITHUB_HOST.test(a)) ? cmd : null;
  if (depth >= 3) return null;
  if (cmd === "eval") return scan(args.join(" "), depth + 1);
  if (SHELLS.has(cmd)) {
    const c = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
    if (c !== -1 && args[c + 1] !== undefined) return scan(args[c + 1]!, depth + 1);
  }
  return null;
}

function scan(text: string, depth: number): string | null {
  const { commands, nested } = split(text);
  for (const words of commands) {
    const hit = blocked(words, depth);
    if (hit) return hit;
  }
  if (depth < 3) {
    for (const inner of nested) {
      const hit = scan(inner, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * The tool a shell command line invokes that the hard rule blocks: `gh`, or `curl`/`wget` aimed at GitHub. Pattern
 * matching on command words (after pipes, `&&`, `;`, subshells, env prefixes, `sudo`, `bash -c`), not a shell
 * parser: `git` and `grep gh` do not match, but a command built at run time (a variable, a script file) is missed.
 */
export function blockedCommand(command: string): string | null {
  return scan(command, 0);
}

/** The shell command of a tool permission request, when it carries one. */
export function requestCommand(request: { input?: Record<string, unknown> }): string | null {
  const input = request.input;
  if (!input) return null;
  if (typeof input.command === "string") return input.command;
  if (typeof input.cmd === "string") return input.cmd;
  if (Array.isArray(input.command) && input.command.every((p) => typeof p === "string")) return (input.command as string[]).join(" ");
  return null;
}

export interface HardRuleDeps {
  enabled: () => boolean;
  log: (entry: Omit<ActivityEntry, "id" | "at">) => void;
}

/** Handler for `agent.permission.before`: denies a blocked command while the hard rule is on. Other requests stay pending. */
export function createHardRuleHandler(deps: HardRuleDeps) {
  return async (event: { agent: { id: string; title: string | null }; request: { id: string; kind?: string; input?: Record<string, unknown> } }, deny: (message: string) => Promise<void>): Promise<void> => {
    if (!deps.enabled()) return;
    const command = requestCommand(event.request);
    if (command === null) return;
    const tool = blockedCommand(command);
    if (!tool) return;
    const started = Date.now();
    try {
      await deny(HARD_RULE_MESSAGE);
    } catch (error) {
      console.error("[github-proxy] could not deny a blocked command:", error);
      return;
    }
    deps.log({
      agentId: event.agent.id,
      agentTitle: event.agent.title ?? "",
      tool: "hard rule",
      repo: "",
      action: tool,
      status: "denied",
      httpStatus: null,
      source: null,
      app: null,
      detail: `Blocked a ${tool} command: ${command.replace(/\s+/g, " ").slice(0, 200)}`,
      ms: Date.now() - started,
    });
  };
}
