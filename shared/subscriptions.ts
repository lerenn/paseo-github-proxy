import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const EVENT_KINDS = ["checks_completed", "review_submitted", "pr_merged", "pr_closed", "comment_created"] as const;
export const eventKindSchema = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof eventKindSchema>;

/** GitHub may be polled no faster than this. The rate limit is shared with everything else. */
export const MIN_POLL_SECONDS = 60;

export const proxySettings = defineSettings({
  id: "proxy",
  scope: "host",
  version: 1,
  schema: z.object({
    /** "auto" opens a webhook forwarder for each watched repository when the token allows it. */
    webhooks: z.enum(["auto", "off"]).default("auto"),
    /** Polling interval for watched pull requests while no forwarder is healthy. */
    pollSeconds: z.number().int().min(MIN_POLL_SECONDS).default(MIN_POLL_SECONDS),
    /** Slower safety-net interval while the repository's forwarder is connected. */
    pollSecondsWithWebhook: z.number().int().min(MIN_POLL_SECONDS).default(300),
    /** Longest timeout an agent may ask for. */
    maxTimeoutMinutes: z.number().int().min(1).default(240),
  }),
});
export type ProxySettings = z.output<typeof proxySettings.schema>;

export const subscriptionStatusSchema = z.enum(["active", "fired", "timed_out", "cancelled"]);

/** What the screen and the tools show. The internal baseline is not part of it. */
export const subscriptionViewSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  repo: z.string(),
  number: z.number(),
  events: z.array(eventKindSchema),
  status: subscriptionStatusSchema,
  createdAt: z.string(),
  /** ISO time when the timeout notice is sent. */
  deadline: z.string(),
  /** How it ended, for non-active subscriptions. */
  outcome: z.string().nullable(),
});
export type SubscriptionView = z.infer<typeof subscriptionViewSchema>;

export const forwarderViewSchema = z.object({
  repo: z.string(),
  state: z.enum(["connecting", "healthy", "unavailable"]),
  detail: z.string().nullable(),
});
export type ForwarderView = z.infer<typeof forwarderViewSchema>;
