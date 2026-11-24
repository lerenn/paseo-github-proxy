import { z } from "zod";
import type { AgentToolDefinition } from "@getpaseo/plugin/server";
import { WAKE_KINDS, WAKE_KIND_INFO } from "./events";
import { DEFAULT_TTL_MINUTES, MAX_TTL_HOURS, MAX_TTL_MINUTES, type Subscription } from "./subscriptions";
import { ProxyError } from "./proxy";
import { clip, need, repoField, type Kit } from "./toolkit";

const view = (s: Subscription, now: number) => ({
  id: s.id,
  repo: s.repo,
  ...(s.number !== null ? { pr: s.number } : {}),
  ...(s.sha ? { sha: s.sha } : {}),
  events: s.events,
  ...(s.conclusions.length ? { conclusions: s.conclusions } : {}),
  ...(s.branch ? { branch: s.branch } : {}),
  ...(s.tag ? { tag: s.tag } : {}),
  ...(s.workflow ? { workflow: s.workflow } : {}),
  ...(s.mentions.length ? { mentions: s.mentions } : {}),
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
      `Ask to be woken when something happens on GitHub, instead of polling. operation: subscribe (repo, events, and optionally pr and/or sha, branch, tag, workflow, conclusion, mentions, persistent, ttl_hours), list (your subscriptions), unsubscribe (id). The event arrives as a short prompt with the event, repository and pull request; read the details with the github_* tools. One-shot by default (removed after it fires); persistent keeps firing until it expires. Expires after ${DEFAULT_TTL_MINUTES / 60} hours by default; pass ttl_hours (for example 24 for a CI wait) up to ${MAX_TTL_HOURS} hours (${MAX_TTL_MINUTES / 1440} days). Filters narrow it, and all of them must match: pr and sha together are an either-or (an event for that pull request or that commit, sha applies to check_run, check_suite, workflow_run and status events too); branch (a trailing * is a prefix; the branch of a check, a push, a queue group, a PR's base) and tag (push, release, tag-triggered workflow runs) name a ref; workflow is a workflow, check run or status context name; conclusion narrows checks_completed (success, failure, cancelled, ...), review_submitted (approved, changes_requested, commented), pr_auto_merge (enabled, disabled) and merge_queue_destroyed (merged, invalidated, dequeued); mentions (comment_added and review_submitted only) wakes only if the comment or review text contains one of the strings, checked on the webhook payload without calling GitHub. For a main CI wait use checks_completed with sha or branch main and workflow; for a tag build use checks_completed with tag; for a merged queue use merge_queue_destroyed with conclusion merged and pr. Events: ${kinds} Works only while the user has enabled the webhook listener and GitHub delivers to it; otherwise nothing ever arrives, so keep a fallback. Checked as the subscribe_events policy action.`,
      z.object({
        operation: z.enum(["subscribe", "list", "unsubscribe"]),
        repo: repoField,
        events: z.array(z.enum(WAKE_KINDS)).optional().describe("subscribe: which events wake you (at least one)."),
        pr: z.number().int().positive().optional().describe("subscribe: a pull request or issue number."),
        sha: z.string().min(7).max(64).optional().describe("subscribe: a commit SHA (at least 7 characters)."),
        conclusion: z.array(z.string().min(1).max(40)).max(10).optional().describe("subscribe: only these conclusions."),
        branch: z.string().min(1).max(200).optional().describe("subscribe: only this branch (a trailing * matches a prefix), e.g. main."),
        tag: z.string().min(1).max(200).optional().describe("subscribe: only this tag (a trailing * matches a prefix), e.g. v1.2.3 or v*."),
        workflow: z.string().min(1).max(100).optional().describe("subscribe: only this workflow, check run or status context name."),
        mentions: z.array(z.string().min(1).max(100)).max(10).optional().describe("subscribe: wake only on a comment or review containing one of these (case-insensitive), e.g. @codex."),
        persistent: z.boolean().optional().describe("subscribe: keep firing instead of once."),
        ttl_hours: z.number().min(0.02).max(MAX_TTL_HOURS).optional().describe(`subscribe: expiry in hours, default ${DEFAULT_TTL_MINUTES / 60}, at most ${MAX_TTL_HOURS}.`),
        expires_in_minutes: z.number().int().min(1).max(MAX_TTL_MINUTES).optional().describe("subscribe: expiry in minutes; ttl_hours wins if both are given."),
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
        if (i.mentions?.length && !events.every((e) => e === "comment_added" || e === "review_submitted")) {
          throw new ProxyError("invalid", "mentions only works with the events comment_added and review_submitted (the other events carry no text). Remove mentions or the other events.");
        }
        try {
          const ttlMinutes = i.ttl_hours !== undefined ? Math.round(i.ttl_hours * 60) : i.expires_in_minutes;
          const sub = subscriptions.add({ agentId, agentTitle: ctx.agent.title ?? agentId, repo, number: i.pr, sha: i.sha, events, conclusions: i.conclusion, branch: i.branch, tag: i.tag, workflow: i.workflow, mentions: i.mentions, persistent: i.persistent, ttlMinutes });
          return `Subscribed. You will be woken by a prompt when it fires.\n${clip(view(sub, now))}`;
        } catch (error) {
          throw new ProxyError("invalid", (error as Error).message);
        }
      },
    ),
  ];
}
