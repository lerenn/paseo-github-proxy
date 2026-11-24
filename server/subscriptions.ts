import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { WAKE_KINDS, type WakeEvent } from "./events";

export const DEFAULT_TTL_MINUTES = 360; // 6 hours
export const MAX_TTL_MINUTES = 10_080; // 7 days
export const MAX_TTL_HOURS = MAX_TTL_MINUTES / 60;
export const MAX_PER_AGENT = 20;
export const MAX_TOTAL = 200;

export const subscriptionSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentTitle: z.string().default(""),
  /** `owner/name`, lower-cased. */
  repo: z.string(),
  /** A pull request or issue number; a number or a sha narrows the subscription, and either one matches. */
  number: z.number().int().positive().nullable().default(null),
  sha: z.string().default(""),
  events: z.array(z.enum(WAKE_KINDS)).min(1),
  /** Only for these conclusions (check conclusion, review state). Empty: any. */
  conclusions: z.array(z.string()).default([]),
  /** A branch name (a trailing `*` is a prefix match). Applies to every event that names refs (checks, push, merge queue, PR base). */
  branch: z.string().default(""),
  /** A tag name (a trailing `*` is a prefix match), for push, release and tag-triggered workflow runs. */
  tag: z.string().default(""),
  /** A workflow, check run or status context name, case-insensitive, exact. */
  workflow: z.string().default(""),
  /** Wake only on a comment or review that contains one of these (case-insensitive), matched against the payload only. */
  mentions: z.array(z.string()).default([]),
  /** A persistent subscription survives its first match; the default one-shot is removed when it fires. */
  persistent: z.boolean().default(false),
  createdAt: z.number(),
  expiresAt: z.number(),
  fired: z.number().default(0),
  lastFiredAt: z.number().nullable().default(null),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

export interface NewSubscription {
  agentId: string;
  agentTitle: string;
  repo: string;
  number?: number | undefined;
  sha?: string | undefined;
  events: Subscription["events"];
  conclusions?: string[] | undefined;
  branch?: string | undefined;
  tag?: string | undefined;
  workflow?: string | undefined;
  mentions?: string[] | undefined;
  persistent?: boolean | undefined;
  ttlMinutes?: number | undefined;
}

const sameSha = (a: string, b: string): boolean => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

/** `main` or `refs/heads/main` to `main`; the part after `refs/tags/` for tags. */
export const bareRef = (ref: string): string => ref.trim().replace(/^refs\/(heads|tags)\//, "");

const refEquals = (want: string, got: string): boolean => (want.endsWith("*") ? got.startsWith(want.slice(0, -1)) : want === got);

/**
 * Whether a subscription wants an event. Expiry is the store's job. Repository, kind, conclusion, branch, tag, workflow
 * and mentions must all match; pr and sha together are an either-or (an event for that pull request or that commit).
 */
export function matches(sub: Subscription, ev: WakeEvent): boolean {
  if (sub.repo !== ev.repo || !sub.events.includes(ev.kind)) return false;
  if (sub.conclusions.length > 0 && !sub.conclusions.includes(ev.conclusion)) return false;
  if (sub.branch && (ev.refType === "tag" || !ev.refs.some((r) => refEquals(sub.branch, r)))) return false;
  if (sub.tag && (ev.refType === "branch" || !ev.refs.some((r) => refEquals(sub.tag, r)))) return false;
  if (sub.workflow && sub.workflow.toLowerCase() !== ev.workflow.toLowerCase()) return false;
  if (sub.mentions.length > 0 && !sub.mentions.some((m) => ev.text.includes(m.toLowerCase()))) return false;
  if (sub.number === null && !sub.sha) return true;
  return (sub.number !== null && ev.numbers.includes(sub.number)) || (!!sub.sha && sameSha(sub.sha.toLowerCase(), ev.sha));
}

/** The agents' subscriptions, kept in `subscriptions.json` so they survive a restart. Not secret. */
export class SubscriptionStore {
  private list: Subscription[] = [];
  private counter = 0;

  constructor(
    private readonly file: string | null,
    private readonly clock: () => number = Date.now,
  ) {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { subscriptions?: unknown };
      const parsed = z.array(subscriptionSchema).safeParse(raw.subscriptions ?? []);
      if (parsed.success) this.list = parsed.data;
    } catch {
      /* none yet, or unreadable: start empty */
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ subscriptions: this.list }, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
      chmodSync(this.file, 0o600);
    } catch (error) {
      console.error("[github-proxy] could not write the subscriptions:", (error as Error).message);
    }
  }

  /** Removes the expired ones. */
  purge(): void {
    const now = this.clock();
    const kept = this.list.filter((s) => s.expiresAt > now);
    if (kept.length !== this.list.length) {
      this.list = kept;
      this.save();
    }
  }

  all(): Subscription[] {
    this.purge();
    return [...this.list];
  }

  forAgent(agentId: string): Subscription[] {
    return this.all().filter((s) => s.agentId === agentId);
  }

  /** Errors are written for the agent. */
  add(input: NewSubscription): Subscription {
    this.purge();
    if (this.list.filter((s) => s.agentId === input.agentId).length >= MAX_PER_AGENT) throw new Error(`You already have ${MAX_PER_AGENT} subscriptions. Unsubscribe from some before adding more.`);
    if (this.list.length >= MAX_TOTAL) throw new Error("There are too many subscriptions in total. Try again later.");
    const ttl = Math.min(Math.max(Math.floor(input.ttlMinutes ?? DEFAULT_TTL_MINUTES), 1), MAX_TTL_MINUTES);
    const now = this.clock();
    const sub: Subscription = {
      id: `sub-${now.toString(36)}-${(this.counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      agentId: input.agentId,
      agentTitle: input.agentTitle,
      repo: input.repo.toLowerCase(),
      number: input.number ?? null,
      sha: (input.sha ?? "").toLowerCase(),
      events: [...new Set(input.events)],
      conclusions: [...new Set((input.conclusions ?? []).map((c) => c.toLowerCase()))],
      branch: bareRef(input.branch ?? ""),
      tag: bareRef(input.tag ?? ""),
      workflow: (input.workflow ?? "").trim(),
      mentions: [...new Set((input.mentions ?? []).map((m) => m.trim()).filter(Boolean))],
      persistent: input.persistent ?? false,
      createdAt: now,
      expiresAt: now + ttl * 60_000,
      fired: 0,
      lastFiredAt: null,
    };
    this.list.push(sub);
    this.save();
    return sub;
  }

  /** Removes one subscription; when `agentId` is given it must be that agent's. True if one was removed. */
  remove(id: string, agentId?: string): boolean {
    const before = this.list.length;
    this.list = this.list.filter((s) => !(s.id === id && (agentId === undefined || s.agentId === agentId)));
    if (this.list.length !== before) this.save();
    return this.list.length !== before;
  }

  /** Drops every subscription of an agent that is gone. */
  dropAgent(agentId: string): number {
    const before = this.list.length;
    this.list = this.list.filter((s) => s.agentId !== agentId);
    if (this.list.length !== before) this.save();
    return before - this.list.length;
  }

  matching(ev: WakeEvent): Subscription[] {
    return this.all().filter((s) => matches(s, ev));
  }

  /** Records a wake-up: a one-shot subscription is removed, a persistent one counts it. */
  fired(id: string): void {
    const sub = this.list.find((s) => s.id === id);
    if (!sub) return;
    if (!sub.persistent) this.list = this.list.filter((s) => s.id !== id);
    else {
      sub.fired++;
      sub.lastFiredAt = this.clock();
    }
    this.save();
  }
}
