import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { auditEntrySchema, type AuditEntry } from "../shared/audit";

export const defaultAuditPath = path.join(homedir(), ".paseo", "github-proxy", "audit.jsonl");
const MAX_BYTES = 5_000_000;

/** Append-only record of every write attempt, allowed or refused. Mode 0600; one rotation. */
export class AuditLog {
  constructor(private readonly file: string = defaultAuditPath) {}

  record(entry: Omit<AuditEntry, "at">) {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      if (existsSync(this.file) && statSync(this.file).size > MAX_BYTES) renameSync(this.file, `${this.file}.1`);
      const fresh = !existsSync(this.file);
      appendFileSync(this.file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
      if (fresh) chmodSync(this.file, 0o600);
    } catch (err) {
      // Auditing must not take writes down, but a failure must be visible in the plugin logs.
      console.error(`github-proxy: cannot write audit log: ${(err as Error).message}`);
    }
  }

  /** Newest first. */
  recent(limit = 100): AuditEntry[] {
    let text = "";
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    const out: AuditEntry[] = [];
    for (const line of text.split("\n").reverse()) {
      if (!line) continue;
      const parsed = auditEntrySchema.safeParse(safeJson(line));
      if (parsed.success) out.push(parsed.data);
      if (out.length >= limit) break;
    }
    return out;
  }
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
