#!/usr/bin/env node
// git credential helper for the GitHub Proxy plugin. No dependencies.
//
//   git config credential.useHttpPath true
//   git config credential.https://github.com.helper '!node /path/to/git-credential-helper.mjs'
//
// Environment: GH_PROXY_URL (the plugin's client API) and GH_PROXY_TOKEN (its bearer token, if one is set).
// `get` asks POST <GH_PROXY_URL>/v1/git-credential and prints the answer; `store` and `erase` do nothing.
// A request that is not https://github.com/<owner>/<repo> gets no answer, so git tries the next helper.
// The helper never blocks git: when the plugin cannot give a token (no App serves the owner, the credential source is gh, a policy
// denial, the API is off, unreachable or slow) it prints nothing and exits 0, so git moves on to its next helper or its prompt.
// The reason goes to stderr only when GH_PROXY_DEBUG or GIT_TERMINAL_PROMPT is set. The token is never written to stderr.
import { fileURLToPath } from "node:url";

/** Parses git's `key=value` lines (up to the first blank line). */
export function parseAttrs(text) {
  const attrs = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (line === "") break;
    const i = line.indexOf("=");
    if (i > 0) attrs[line.slice(0, i)] = line.slice(i + 1);
  }
  return attrs;
}

const TIMEOUT_MS = 3000;

/** Runs one invocation. Returns what to write on stdout and stderr, and the exit code (always 0). */
export async function run({ argv, stdin, env, fetch: fetchFn = globalThis.fetch, timeoutMs = TIMEOUT_MS }) {
  const op = argv[0];
  if (op !== "get") return { stdout: "", stderr: "", code: 0 };
  const attrs = parseAttrs(stdin);
  if (attrs.protocol !== "https" || (attrs.host ?? "").toLowerCase() !== "github.com" || !attrs.path) return { stdout: "", stderr: "", code: 0 };
  const debug = Boolean(env.GH_PROXY_DEBUG || env.GIT_TERMINAL_PROMPT);
  const none = (reason) => ({ stdout: "", stderr: debug ? `git-credential-helper: ${reason}\n` : "", code: 0 });
  const base = (env.GH_PROXY_URL ?? "").replace(/\/+$/, "");
  if (!base) return none("GH_PROXY_URL is not set (the GitHub Proxy client API is off, or this session was opened before it was enabled).");
  let res;
  try {
    res = await fetchFn(`${base}/v1/git-credential`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(env.GH_PROXY_TOKEN ? { authorization: `Bearer ${env.GH_PROXY_TOKEN}` } : {}) },
      body: JSON.stringify({ protocol: attrs.protocol, host: attrs.host, path: attrs.path }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return none(`the GitHub Proxy client API is unreachable at ${base}: ${error.message}`);
  }
  let body = {};
  try {
    body = JSON.parse(await res.text());
  } catch {
    /* keep the empty body */
  }
  if (res.status !== 200 || !body.password) return none(`no token (HTTP ${res.status}): ${body.message ?? body.error ?? "no answer"}`);
  return { stdout: `username=${body.username ?? "x-access-token"}\npassword=${body.password}\n\n`, stderr: "", code: 0 };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await run({ argv: process.argv.slice(2), stdin: await readStdin(), env: process.env });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  process.exitCode = result.code;
}
