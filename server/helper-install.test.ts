import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HELPER_FILE, installHelper } from "./helper-install";
import { HELPER_SOURCE } from "./helper-source";

const sourceFile = path.join(__dirname, "git-credential-helper.mjs");

describe("embedded helper", () => {
  it("equals git-credential-helper.mjs (run: node .github/scripts/embed-helper.mjs)", () => {
    expect(HELPER_SOURCE).toBe(readFileSync(sourceFile, "utf8"));
  });
});

describe("installHelper", () => {
  it("writes the script into the data directory with mode 0700 and rewrites it when it differs", () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "helper-")), "data");
    const first = installHelper(dir);
    expect(first).toEqual({ path: path.join(dir, HELPER_FILE), error: "" });
    expect(readFileSync(first.path!, "utf8")).toBe(readFileSync(sourceFile, "utf8"));
    expect(statSync(first.path!).mode & 0o777).toBe(0o700);
    writeFileSync(first.path!, "old");
    chmodSync(first.path!, 0o700);
    installHelper(dir);
    expect(readFileSync(first.path!, "utf8")).toBe(HELPER_SOURCE);
  });

  it("does not rewrite an identical copy", () => {
    const write = vi.fn();
    installHelper("/d", { read: () => HELPER_SOURCE, write });
    expect(write).not.toHaveBeenCalled();
  });

  it("reports the reason when it cannot write", () => {
    const r = installHelper("/ro", { read: () => null, write: () => { throw new Error("EROFS: read-only file system"); } });
    expect(r.path).toBeNull();
    expect(r.error).toContain("EROFS");
    expect(r.error).toContain(path.join("/ro", HELPER_FILE));
  });
});

describe("written helper, end to end", () => {
  const runHelper = (file: string, op: string, input: string, env: Record<string, string>) =>
    new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
      const child = spawn(process.execPath, [file, op], { env: { PATH: process.env.PATH ?? "", ...env } });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ stdout, stderr, code }));
      child.stdin.end(input);
    });

  it("get returns username and password; unsupported hosts return nothing", async () => {
    const seen: { auth?: string; body: string }[] = [];
    const api = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ auth: req.headers.authorization, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ username: "x-access-token", password: "ghs_fake" }));
      });
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    try {
      const port = (api.address() as { port: number }).port;
      const { path: file } = installHelper(mkdtempSync(path.join(tmpdir(), "helper-")));
      const env = { GH_PROXY_URL: `http://127.0.0.1:${port}`, GH_PROXY_TOKEN: "tok" };
      const ok = await runHelper(file!, "get", "protocol=https\nhost=github.com\npath=acme/web.git\n\n", env);
      expect(ok).toEqual({ stdout: "username=x-access-token\npassword=ghs_fake\n\n", stderr: "", code: 0 });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.auth).toBe("Bearer tok");
      expect(JSON.parse(seen[0]!.body)).toEqual({ protocol: "https", host: "github.com", path: "acme/web.git" });
      const other = await runHelper(file!, "get", "protocol=https\nhost=gitlab.com\npath=a/b\n\n", env);
      expect(other).toEqual({ stdout: "", stderr: "", code: 0 });
      expect(seen).toHaveLength(1);
    } finally {
      api.closeAllConnections();
      await new Promise((r) => api.close(r));
    }
  });
});
