import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HELPER_SOURCE } from "./helper-source";

export const HELPER_FILE = "git-credential-helper.mjs";

export interface HelperInstall {
  /** Absolute path of the written script, or null when it could not be written. */
  path: string | null;
  /** Why it could not be written (empty when it was). */
  error: string;
}

export interface HelperFs {
  read: (file: string) => string | null;
  write: (file: string, content: string, mode: number) => void;
}

const nodeFs: HelperFs = {
  read: (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
  write: (file, content, mode) => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, content, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, file); // atomic: git never runs a half-written helper
  },
};

/**
 * Puts the credential helper in the plugin's data directory (next to config.json), mode 0700, rewriting it only when
 * its content differs. The script is embedded in the server code, so the install layout does not matter.
 */
export function installHelper(dir: string, fs: HelperFs = nodeFs, source: string = HELPER_SOURCE): HelperInstall {
  const file = path.join(dir, HELPER_FILE);
  try {
    if (fs.read(file) !== source) fs.write(file, source, 0o700);
    return { path: file, error: "" };
  } catch (error) {
    return { path: null, error: `could not write ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
