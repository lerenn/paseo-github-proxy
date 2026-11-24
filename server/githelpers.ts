import { execFile } from "node:child_process";
import type { ExecFn } from "./auth";

const TIMEOUT_MS = 3000;
const TTL_MS = 60_000;

/** `git config` with a short timeout (the shared default exec waits 15 s, too long for opening a session). */
export const gitConfigExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: TIMEOUT_MS, maxBuffer: 100_000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve({ stdout, stderr });
    });
  });

/**
 * The github.com credential helpers git already has (`git config --get-all credential.https://github.com.helper`),
 * kept as fallbacks behind the plugin helper. Cached for a minute. Any failure (no git, no value, timeout) means none.
 */
export class GitHelperFallbacks {
  private cached: { at: number; values: string[] } | null = null;

  constructor(
    private readonly exec: ExecFn = gitConfigExec,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = TTL_MS,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {}

  async list(): Promise<string[]> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.values;
    let values: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("git config timed out")), this.timeoutMs);
      });
      const { stdout } = await Promise.race([this.exec("git", ["config", "--get-all", HELPER_KEY]), timeout]);
      values = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } catch {
      values = [];
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.cached = { at: this.now(), values };
    return values;
  }
}

export const HELPER_KEY = "credential.https://github.com.helper";
