import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { budgetSnapshotSchema } from "./budget";

export const ownerStatusSchema = z.object({
  owner: z.string(),
  /** Other owners that use the same token share this budget. */
  sharesBudgetWith: z.array(z.string()),
  budget: budgetSnapshotSchema,
  /** Why the last budget refresh failed (for example a rejected token), else null. */
  error: z.string().nullable(),
});
export type OwnerStatus = z.infer<typeof ownerStatusSchema>;

export const cacheStatsSchema = z.object({
  entries: z.number(),
  hits: z.number(),
  misses: z.number(),
});

export const endpointSchema = z.object({
  /** Local URL agents reach, or null when the port could not be bound. */
  url: z.string().nullable(),
  error: z.string().nullable(),
});

const statusOutput = z.object({ owners: z.array(ownerStatusSchema), cache: cacheStatsSchema, endpoint: endpointSchema });

export const statusRpc = defineRpc({
  name: "github-proxy.status",
  input: z.object({}),
  output: statusOutput,
});

/** Store a token for an owner. The token is validated against GitHub, then never returned. */
export const setTokenRpc = defineRpc({
  name: "github-proxy.set-token",
  input: z.object({ owner: z.string(), token: z.string() }),
  output: z.object({}),
});

export const clearTokenRpc = defineRpc({
  name: "github-proxy.clear-token",
  input: z.object({ owner: z.string() }),
  output: z.object({}),
});

/** Re-read the budget from GitHub's /rate_limit endpoint, which does not consume budget. */
export const refreshBudgetRpc = defineRpc({
  name: "github-proxy.refresh-budget",
  input: z.object({}),
  output: statusOutput,
});
