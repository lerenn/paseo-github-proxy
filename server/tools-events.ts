import { z } from "zod";
import type { AgentToolDefinition } from "@getpaseo/plugin/server";
import { WAKE_KINDS, WAKE_KIND_INFO } from "./events";
import { DEFAULT_TTL_MINUTES, MAX_TTL_MINUTES, type Subscription } from "./subscriptions";
import { ProxyError } from "./proxy";
import { clip, need, repoField, type Kit } from "./toolkit";

const view = (s: Subscription, now: number) => ({
  id: s.id,
  repo: s.repo,
  ...(s.number !== null ? { pr: s.number } : {}),
  ...(s.sha ? { sha: s.sha } : {}),
  events: s.events,
  ...(s.conclusions.length ? { conclusions: s.conclusions } : {}),
  persistent: s.persistent,
  expires_in_minutes: Math.max(0, Math.round((s.expiresAt - now) / 60_000)),
});

/** github_subscribe: ask to be woken by a GitHub event. Needs the webhook listener (Auth tab) to be on. */
export function eventTools(kit: Kit): AgentToolDefinition[] {
  const { tool, proxy, subscriptions } = kit;
  if (!subscriptions) return [];
  const kinds = WAKE_KINDS.map((k) => `${k} (${WAKE_KIND_INFO[k]})`).join(" ");
  return [
    tool(
      "github_subscribe",
      `Ask to be woken when something happens on GitHub, instead of polling. operation: subscribe (repo, events, and optionally pr and/or sha to narrow it, conclusion, persistent, expires_in_minutes), list (your subscriptions), unsubscribe (id). The event arrives as a short prompt with the event, repository and pull request; read the details with the github_* tools. One-shot by default (removed after it fires); persistent keeps firing until it expires. Expires after ${DEFAULT_TTL_MINUTES / 60} hours by default, at most ${MAX_TTL_MINUTES / 1440} days. pr and sha each narrow the subscription; an event for that pull request or that commit matches. conclusion narrows checks_completed (success, failure, cancelled, ...) and review_submitted (approved, changes_requested, commented). Events: ${kinds} Works only while the user has enabled the webhook listener and GitHub delivers to it; otherwise nothing ever arrives, so keep a fallback. Checked as the subscribe_events policy action.`,
      z.object({
        operation: z.enum(["subscribe", "list", "unsubscribe"]),
        repo: repoField,
        events: z.array(z.enum(WAKE_KINDS)).optional().describe("subscribe: which events wake you (at least one)."),
        pr: z.number().int().positive().optional().describe("subscribe: a pull request or issue number."),
        sha: z.string().min(7).max(64).optional().describe("subscribe: a commit SHA (at least 7 characters)."),
        conclusion: z.array(z.string().min(1).max(40)).max(10).optional().describe("subscribe: only these conclusions."),
        persistent: z.boolean().optional().describe("subscribe: keep firing instead of once."),
        expires_in_minutes: z.number().int().min(1).max(MAX_TTL_MINUTES).optional().describe(`subscribe: default ${DEFAULT_TTL_MINUTES}.`),
        id: z.string().optional().describe("unsubscribe: the subscription id."),
      }),
      async (i, ctx, c) => {
        const agentId = c.ctx.agentId;
        const now = Date.now();
        if (i.operation === "list") return clip({ subscriptions: subscriptions.forAgent(agentId).map((s) => view(s, now)) });
        if (i.operation === "unsubscribe") {
          const id = need(i.id, "id", "unsubscribe");
          return subscriptions.remove(id, agentId) ? `Unsubscribed ${id}.` : `You have no subscription ${id}.`;
        }
        const repo = (await c.repo(i.repo)).toLowerCase();
        const events = need(i.events?.length ? i.events : undefined, "events (at least one)", "subscribe");
        proxy.authorize(c.ctx, repo, ["subscribe_events"], `${events.join(",")}${i.pr ? ` #${i.pr}` : ""}`);
        try {
          const sub = subscriptions.add({ agentId, agentTitle: ctx.agent.title ?? agentId, repo, number: i.pr, sha: i.sha, events, conclusions: i.conclusion, persistent: i.persistent, ttlMinutes: i.expires_in_minutes });
          return `Subscribed. You will be woken by a prompt when it fires.\n${clip(view(sub, now))}`;
        } catch (error) {
          throw new ProxyError("invalid", (error as Error).message);
        }
      },
    ),
  ];
}
