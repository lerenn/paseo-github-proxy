import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { EventKind, ProxySettings, SubscriptionView } from "../shared/subscriptions";
import { MIN_POLL_SECONDS } from "../shared/subscriptions";
import type { Forwarders } from "./forwarder";
import { UsageError, type OpsContext } from "./ops";
import { eventPrompt, timeoutPrompt } from "./prompts";
import { baselineOf, detect, snapshot, type Baseline, type Snapshot, type WatchState } from "./watch";

export const defaultSubscriptionsPath = path.join(homedir(), ".paseo", "github-proxy", "subscriptions.json");

interface Stored {
  id: string;
  agentId: string;
  repo: string;
  number: number;
  events: EventKind[];
  createdAt: number;
  deadline: number;
  timeoutSeconds: number;
  ignoreAuthors: string[];
  baseline: Baseline;
  status: SubscriptionView["status"];
  outcome: string | null;
  /** The restart happened while this was waiting. */
  restarted?: boolean;
}

export interface ManagerDeps {
  ctx: () => OpsContext;
  /** Wake an agent. Rejects when it cannot be reached. */
  send: (agentId: string, text: string) => Promise<void>;
  settings: () => Promise<ProxySettings>;
  forwarders: Pick<Forwarders, "ensure" | "release" | "healthy">;
  file?: string;
  /** How long checks must stay settled before checks_completed fires. */
  settleMs?: number;
  /** Poll scheduler tick. */
  tickMs?: number;
}

const HISTORY = 20;
const MAX_ACTIVE = 100;

/**
 * Subscriptions: an agent asks to be woken when something happens on a pull request, with a
 * deadline. Webhook deliveries only say "look at this PR now"; what happened is always decided by
 * diffing GitHub's current state against the subscription's baseline, so the webhook path and the
 * polling safety net cannot disagree, and a subscription fires at most once.
 */
export class SubscriptionManager {
  private subs: Stored[];
  private readonly state = new Map<string, WatchState>();
  private readonly nextPoll = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly rechecks = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly busy = new Set<string>();
  private tick: ReturnType<typeof setInterval> | null = null;
  private readonly file: string;

  constructor(private readonly d: ManagerDeps) {
    this.file = d.file ?? defaultSubscriptionsPath;
    this.subs = this.load();
  }

  private load(): Stored[] {
    try {
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
  }

  private save() {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.subs), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  /** Restore timers and polling after a restart. Subscriptions whose deadline passed while down time out now. */
  start() {
    for (const s of this.subs) if (s.status === "active") s.restarted = true;
    for (const s of this.active()) this.arm(s);
    for (const repo of new Set(this.active().map((s) => s.repo))) void this.ensureForwarder(repo);
    this.tick = setInterval(() => void this.pollDue(), this.d.tickMs ?? 15_000);
  }

  stop() {
    if (this.tick) clearInterval(this.tick);
    for (const t of [...this.timers.values(), ...this.rechecks.values()]) clearTimeout(t);
    this.timers.clear();
    this.rechecks.clear();
  }

  private active() {
    return this.subs.filter((s) => s.status === "active");
  }

  private view(s: Stored): SubscriptionView {
    return {
      id: s.id, agentId: s.agentId, repo: s.repo, number: s.number, events: s.events, status: s.status,
      createdAt: new Date(s.createdAt).toISOString(), deadline: new Date(s.deadline).toISOString(), outcome: s.outcome,
    };
  }

  list(agentId?: string): SubscriptionView[] {
    return this.subs.filter((s) => !agentId || s.agentId === agentId).map((s) => this.view(s));
  }

  async subscribe(
    caller: { agentId: string | null },
    req: { repo: string; number: number; events: EventKind[]; timeoutSeconds: number; ignoreAuthors?: string[] },
  ): Promise<{ subscription: SubscriptionView } | { satisfied: string }> {
    if (!caller.agentId) throw new UsageError("This session is not bound to an agent yet, so it cannot be woken. Try again in a moment.");
    const settings = await this.d.settings();
    if (!req.events.length) throw new UsageError("Pass at least one event.");
    const timeout = Math.min(req.timeoutSeconds, settings.maxTimeoutMinutes * 60);
    if (this.active().length >= MAX_ACTIVE) throw new UsageError(`Too many active subscriptions (${MAX_ACTIVE}).`);
    const repo = req.repo.toLowerCase();
    const [owner, name] = repo.split("/");

    const kinds = new Set(req.events);
    const snap = await snapshot(this.d.ctx(), { owner, repo: name }, req.number, kinds);
    const baseline = baselineOf(snap);
    // Conditions that already hold are answered now instead of waiting for a change that will not come.
    if (kinds.has("pr_merged") && snap.merged) return { satisfied: `${repo}#${req.number} is already merged.` };
    if (kinds.has("pr_closed") && snap.closed && !snap.merged) return { satisfied: `${repo}#${req.number} is already closed.` };
    if (kinds.has("checks_completed") && baseline.checksSettled) {
      const bad = snap.checks!.filter((c) => c.bucket === "fail").length;
      return { satisfied: `Checks on ${repo}#${req.number} (commit ${snap.headSha.slice(0, 8)}) have already finished: ${bad ? `${bad} failed` : "all passed"}. Subscribe after the next push to wait for new checks.` };
    }

    const now = Date.now();
    const sub: Stored = {
      id: randomUUID().slice(0, 8), agentId: caller.agentId, repo, number: req.number, events: [...kinds], createdAt: now,
      deadline: now + timeout * 1000, timeoutSeconds: timeout, ignoreAuthors: req.ignoreAuthors ?? [], baseline, status: "active", outcome: null,
    };
    this.subs.push(sub);
    this.trim();
    this.save();
    this.arm(sub);
    this.nextPoll.set(this.key(sub), now + (await this.interval(repo)) * 1000);
    void this.ensureForwarder(repo);
    return { subscription: this.view(sub) };
  }

  cancel(id: string, agentId?: string): boolean {
    const s = this.subs.find((x) => x.id === id && x.status === "active" && (!agentId || x.agentId === agentId));
    if (!s) return false;
    this.finish(s, "cancelled", "cancelled");
    return true;
  }

  /** A webhook said these pull requests (or commits) changed: look now. */
  async hint(repo: string, numbers: number[], shas: string[]) {
    const r = repo.toLowerCase();
    const targets = new Set(numbers);
    for (const s of this.active()) if (s.repo === r && shas.includes(s.baseline.headSha)) targets.add(s.number);
    for (const n of targets) await this.check(r, n);
  }

  private key = (s: { repo: string; number: number }) => `${s.repo}#${s.number}`;

  private arm(s: Stored) {
    const wait = Math.max(0, s.deadline - Date.now());
    this.timers.set(s.id, setTimeout(() => void this.timeout(s), wait));
  }

  private async interval(repo: string): Promise<number> {
    const st = await this.d.settings();
    return Math.max(MIN_POLL_SECONDS, this.d.forwarders.healthy(repo) ? st.pollSecondsWithWebhook : st.pollSeconds);
  }

  private async ensureForwarder(repo: string) {
    if ((await this.d.settings()).webhooks === "auto") this.d.forwarders.ensure(repo);
  }

  /** Polling safety net. */
  private async pollDue() {
    const now = Date.now();
    const due = new Map<string, { repo: string; number: number }>();
    for (const s of this.active()) {
      const k = this.key(s);
      if ((this.nextPoll.get(k) ?? 0) <= now) due.set(k, { repo: s.repo, number: s.number });
    }
    for (const t of due.values()) await this.check(t.repo, t.number);
  }

  /** Read one pull request once for all of its subscriptions, fire what matches. */
  private async check(repo: string, number: number) {
    const k = `${repo}#${number}`;
    if (this.busy.has(k)) return;
    const subs = this.active().filter((s) => s.repo === repo && s.number === number);
    if (!subs.length) return;
    this.busy.add(k);
    try {
      const kinds = new Set(subs.flatMap((s) => s.events));
      const [owner, name] = repo.split("/");
      const snap = await snapshot(this.d.ctx(), { owner, repo: name }, number, kinds);
      const settleMs = this.d.settleMs ?? 20_000;
      for (const s of subs) {
        if (s.status !== "active") continue;
        const st = this.state.get(s.id) ?? {};
        this.state.set(s.id, st);
        const { matches, recheckInMs } = detect(s.events, s.baseline, snap, st, Date.now(), settleMs, s.ignoreAuthors);
        if (matches.length) await this.fire(s, matches);
        else if (recheckInMs !== null) this.recheck(repo, number, recheckInMs);
      }
    } catch (err) {
      // Rate-limited or transient: the next tick tries again; the deadline still bounds the wait.
      console.error(`github-proxy: poll of ${k} failed: ${(err as Error).message}`);
    } finally {
      this.busy.delete(k);
      this.nextPoll.set(k, Date.now() + (await this.interval(repo)) * 1000);
    }
  }

  private recheck(repo: string, number: number, ms: number) {
    const k = `${repo}#${number}`;
    if (this.rechecks.has(k)) return;
    this.rechecks.set(k, setTimeout(() => {
      this.rechecks.delete(k);
      void this.check(repo, number);
    }, ms));
  }

  private async fire(s: Stored, matches: ReturnType<typeof detect>["matches"]) {
    if (s.status !== "active") return;
    this.finish(s, "fired", matches.map((m) => m.kind).join(", "));
    await this.wake(s, eventPrompt(this.view(s), matches));
  }

  private async timeout(s: Stored) {
    if (s.status !== "active") return;
    let snap: Snapshot | null = null;
    try {
      const [owner, name] = s.repo.split("/");
      snap = await snapshot(this.d.ctx(), { owner, repo: name }, s.number, new Set(s.events));
    } catch {
      // Report the timeout even when the state cannot be read.
    }
    // Something may have happened since the last poll; do not report a timeout over a real event.
    if (snap) {
      const { matches } = detect(s.events, s.baseline, snap, this.state.get(s.id) ?? {}, Date.now(), 0, s.ignoreAuthors);
      if (matches.length) return this.fire(s, matches);
    }
    const restarted = Boolean(s.restarted);
    this.finish(s, "timed_out", "timed out");
    await this.wake(s, timeoutPrompt(this.view(s), snap, restarted, s.timeoutSeconds));
  }

  private finish(s: Stored, status: SubscriptionView["status"], outcome: string) {
    s.status = status;
    s.outcome = outcome;
    clearTimeout(this.timers.get(s.id));
    this.timers.delete(s.id);
    this.state.delete(s.id);
    this.trim();
    this.save();
    if (!this.active().some((x) => x.repo === s.repo)) void this.d.forwarders.release(s.repo);
  }

  /** Keep the newest finished subscriptions for the screen, drop the rest. */
  private trim() {
    const done = this.subs.filter((s) => s.status !== "active");
    if (done.length <= HISTORY) return;
    const drop = new Set(done.slice(0, done.length - HISTORY).map((s) => s.id));
    this.subs = this.subs.filter((s) => !drop.has(s.id));
  }

  private async wake(s: Stored, text: string) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.d.send(s.agentId, text);
        return;
      } catch (err) {
        if (attempt === 3) {
          s.outcome = `${s.outcome}; agent unreachable: ${(err as Error).message}`;
          this.save();
          console.error(`github-proxy: could not wake agent ${s.agentId} for ${s.id}: ${(err as Error).message}`);
        } else {
          await new Promise((r) => setTimeout(r, attempt * 2000));
        }
      }
    }
  }

  /** The agent is gone: its subscriptions are pointless. */
  dropAgent(agentId: string) {
    for (const s of this.active().filter((x) => x.agentId === agentId)) this.finish(s, "cancelled", "agent archived");
  }
}
