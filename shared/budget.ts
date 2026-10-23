import { z } from "zod";

/** Request priority. Lower-priority work waits first when the budget runs low. */
export const priorities = ["interactive", "normal", "background"] as const;
export const prioritySchema = z.enum(priorities);
export type Priority = z.infer<typeof prioritySchema>;

/** GitHub rate-limit buckets the proxy distinguishes. */
export const resourceSchema = z.enum(["core", "graphql", "search"]);
export type Resource = z.infer<typeof resourceSchema>;

export const resourceBudgetSchema = z.object({
  resource: resourceSchema,
  limit: z.number().nullable(),
  /** Last observed remaining count, minus requests currently in flight. Null until observed. */
  remaining: z.number().nullable(),
  /** Epoch milliseconds when the bucket resets. */
  resetAt: z.number().nullable(),
});
export type ResourceBudget = z.infer<typeof resourceBudgetSchema>;

export const budgetSnapshotSchema = z.object({
  resources: z.array(resourceBudgetSchema),
  /** Requests waiting for budget or a slot. */
  queued: z.number(),
  inFlight: z.number(),
  /** Epoch milliseconds until which every request waits (primary or secondary limit), or null. */
  pausedUntil: z.number().nullable(),
  pauseReason: z.string().nullable(),
});
export type BudgetSnapshot = z.infer<typeof budgetSnapshotSchema>;
