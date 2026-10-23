import { z } from "zod";
import { operationSchema } from "./policy";

export const auditEntrySchema = z.object({
  /** ISO time. */
  at: z.string(),
  agentId: z.string().nullable(),
  repo: z.string().nullable(),
  ops: z.array(operationSchema),
  /** "allowed" and the call succeeded or failed upstream, or "refused" by policy before reaching GitHub. */
  decision: z.enum(["allowed", "refused"]),
  /** Short description of what was attempted. Never contains request bodies. */
  summary: z.string(),
  /** Why it was refused, or the GitHub error for an allowed call that failed. */
  detail: z.string().nullable(),
  /** HTTP status for allowed calls. */
  status: z.number().nullable(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;
