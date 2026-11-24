import { z } from "zod";
import { SOURCES } from "./config";

export const rateLimitSchema = z.object({
  resource: z.string(),
  limit: z.number(),
  remaining: z.number(),
  /** Epoch ms when the window resets. */
  resetAt: z.number(),
  observedAt: z.number(),
});
export type RateLimitView = z.infer<typeof rateLimitSchema>;

export const sourceStatusSchema = z.object({
  source: z.enum(SOURCES),
  /** Credential identity: `gh`, or `app:<id>` (rate limits and caches are kept per key). */
  key: z.string(),
  label: z.string(),
  /** For an App: the owners it claims, and whether it is the default one. */
  owners: z.array(z.string()),
  default: z.boolean(),
  configured: z.boolean(),
  active: z.boolean(),
  /** Set while the source is refused until this epoch ms (a primary or secondary rate limit). */
  blockedUntil: z.number().nullable(),
  limits: z.array(rateLimitSchema),
});
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

export const activityStatus = z.enum(["allowed", "cached", "revalidated", "denied", "error", "rate_limited"]);
export type ActivityStatus = z.infer<typeof activityStatus>;

export const activityEntrySchema = z.object({
  id: z.number(),
  at: z.number(),
  agentId: z.string(),
  agentTitle: z.string(),
  tool: z.string(),
  repo: z.string(),
  action: z.string(),
  status: activityStatus,
  httpStatus: z.number().nullable(),
  source: z.enum(SOURCES).nullable(),
  /** Label of the GitHub App that served the call, when one did. */
  app: z.string().nullable(),
  detail: z.string(),
  ms: z.number(),
});
export type ActivityEntry = z.infer<typeof activityEntrySchema>;

export const statsSchema = z.object({
  requests: z.number(),
  upstream: z.number(),
  cacheHits: z.number(),
  revalidated: z.number(),
  denied: z.number(),
  errors: z.number(),
  /** 0..1, share of requests answered without a full upstream response. */
  hitRate: z.number(),
  cacheEntries: z.number(),
  /** Requests per minute for the last 30 minutes, oldest first. */
  series: z.array(z.object({ upstream: z.number(), cached: z.number() })),
});
export type Stats = z.infer<typeof statsSchema>;

export const overviewSchema = z.object({
  now: z.number(),
  sources: z.array(sourceStatusSchema),
  stats: statsSchema,
  allowedOwnersEmpty: z.boolean(),
  warnings: z.array(z.string()),
});
export type Overview = z.infer<typeof overviewSchema>;
