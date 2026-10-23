import type { BudgetSnapshot, Priority, Resource } from "../shared/budget";
import { priorities } from "../shared/budget";

/** A request could not run within its wait allowance because GitHub's limits are exhausted. */
export class RateLimitError extends Error {
  constructor(
    message: string,
    /** Epoch milliseconds when a retry is expected to work. */
    readonly retryAt: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

export interface LimiterOptions {
  /** Longest a request may wait for budget before failing with RateLimitError. */
  maxWaitMs?: number;
  /** Concurrent requests per token. Secondary limits punish bursts, so keep this small. */
  concurrency?: number;
  /** Minimum gap between two writes on one token, as GitHub recommends. */
  writeGapMs?: number;
  /** First secondary-limit backoff when GitHub gives no Retry-After; doubles up to maxBackoffMs. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface JobOptions {
  resource: Resource;
  priority: Priority;
  write?: boolean;
  maxWaitMs?: number;
}

/**
 * Remaining share of a bucket that must be left for a priority to run. Background work stops
 * first, so interactive requests still have budget when the bucket is nearly empty.
 */
const reserve: Record<Priority, number> = { interactive: 0, normal: 0.1, background: 0.3 };

interface Bucket {
  limit: number | null;
  remaining: number | null;
  resetAt: number | null;
  inFlight: number;
}

interface Job {
  opts: JobOptions;
  deadline: number;
  send: () => Promise<Response>;
  resolve: (res: Response) => void;
  reject: (err: unknown) => void;
  attempts: number;
}

class TokenState {
  buckets = new Map<Resource, Bucket>();
  queue: Job[] = [];
  active = 0;
  pausedUntil = 0;
  pauseReason: string | null = null;
  backoffMs = 0;
  nextWriteAt = 0;
  timer: ReturnType<typeof setTimeout> | null = null;

  bucket(resource: Resource): Bucket {
    let b = this.buckets.get(resource);
    if (!b) {
      b = { limit: null, remaining: null, resetAt: null, inFlight: 0 };
      this.buckets.set(resource, b);
    }
    return b;
  }
}

/**
 * One shared budget per token: a priority queue in front of GitHub that tracks the rate-limit
 * headers, holds low-priority work back as the budget shrinks, and pauses everyone on primary and
 * secondary limits.
 */
export class RateLimiter {
  private readonly states = new Map<string, TokenState>();
  private readonly o: Required<LimiterOptions>;

  constructor(options: LimiterOptions = {}) {
    this.o = {
      maxWaitMs: options.maxWaitMs ?? 60_000,
      concurrency: options.concurrency ?? 4,
      writeGapMs: options.writeGapMs ?? 1000,
      baseBackoffMs: options.baseBackoffMs ?? 60_000,
      maxBackoffMs: options.maxBackoffMs ?? 15 * 60_000,
    };
  }

  private state(key: string): TokenState {
    let s = this.states.get(key);
    if (!s) this.states.set(key, (s = new TokenState()));
    return s;
  }

  /** Run `send` when the budget allows. The response is returned whatever its status, except limit blocks, which are retried after the pause. */
  schedule(key: string, opts: JobOptions, send: () => Promise<Response>): Promise<Response> {
    return new Promise((resolve, reject) => {
      const s = this.state(key);
      const job: Job = {
        opts,
        deadline: Date.now() + (opts.maxWaitMs ?? this.o.maxWaitMs),
        send,
        resolve,
        reject,
        attempts: 0,
      };
      this.enqueue(s, job);
      this.pump(s);
    });
  }

  /** Feed the buckets from GitHub's `GET /rate_limit` body (`resources`). */
  observeResources(key: string, resources: Record<string, { limit: number; remaining: number; reset: number }>) {
    const s = this.state(key);
    for (const name of ["core", "graphql", "search"] as const) {
      const r = resources[name];
      if (!r) continue;
      const b = s.bucket(name);
      b.limit = r.limit;
      b.remaining = r.remaining;
      b.resetAt = r.reset * 1000;
    }
  }

  snapshot(key: string): BudgetSnapshot {
    const s = this.state(key);
    const now = Date.now();
    const resources = (["core", "graphql", "search"] as const).map((resource) => {
      const b = s.bucket(resource);
      const expired = b.resetAt !== null && b.resetAt <= now;
      return {
        resource,
        limit: b.limit,
        remaining: expired ? b.limit : b.remaining === null ? null : Math.max(0, b.remaining - b.inFlight),
        resetAt: expired ? null : b.resetAt,
      };
    });
    return {
      resources,
      queued: s.queue.length,
      inFlight: s.active,
      pausedUntil: s.pausedUntil > now ? s.pausedUntil : null,
      pauseReason: s.pausedUntil > now ? s.pauseReason : null,
    };
  }

  /** Drop timers; pending jobs are rejected. */
  stop() {
    for (const s of this.states.values()) {
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
      for (const job of s.queue.splice(0)) job.reject(new Error("GitHub proxy stopped"));
    }
  }

  private enqueue(s: TokenState, job: Job) {
    const rank = (j: Job) => priorities.indexOf(j.opts.priority);
    let i = s.queue.length;
    while (i > 0 && rank(s.queue[i - 1]) > rank(job)) i--;
    s.queue.splice(i, 0, job);
  }

  /** Milliseconds the head job must wait, 0 when it may start. */
  private delayFor(s: TokenState, job: Job, now: number): { ms: number; reason: string } {
    if (s.pausedUntil > now) return { ms: s.pausedUntil - now, reason: s.pauseReason ?? "rate limited" };
    const b = s.bucket(job.opts.resource);
    if (b.resetAt !== null && b.resetAt <= now) {
      // The window rolled over: the old reading no longer applies.
      b.remaining = b.limit;
      b.resetAt = null;
    }
    if (b.remaining !== null && b.limit !== null && b.resetAt !== null) {
      const available = b.remaining - b.inFlight;
      const needed = Math.max(1, Math.ceil(b.limit * reserve[job.opts.priority]));
      if (available < needed) {
        return { ms: b.resetAt - now + 1000, reason: `${job.opts.resource} budget low for ${job.opts.priority} requests` };
      }
    }
    if (job.opts.write && s.nextWriteAt > now) return { ms: s.nextWriteAt - now, reason: "write spacing" };
    return { ms: 0, reason: "" };
  }

  private pump(s: TokenState) {
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    while (s.queue.length > 0) {
      const now = Date.now();
      const head = s.queue[0];
      const { ms, reason } = this.delayFor(s, head, now);
      if (ms > 0) {
        if (now + ms > head.deadline) {
          s.queue.shift();
          head.reject(new RateLimitError(`${reason}; retry after ${new Date(now + ms).toISOString()}`, now + ms));
          continue;
        }
        s.timer = setTimeout(() => this.pump(s), ms);
        return;
      }
      if (s.active >= this.o.concurrency) return;
      s.queue.shift();
      this.start(s, head);
    }
  }

  private start(s: TokenState, job: Job) {
    const bucket = s.bucket(job.opts.resource);
    s.active++;
    bucket.inFlight++;
    if (job.opts.write) s.nextWriteAt = Date.now() + this.o.writeGapMs;
    job.attempts++;
    job
      .send()
      .then(
        async (res) => {
          bucket.inFlight--;
          s.active--;
          const pause = await this.observe(s, job.opts.resource, res);
          if (pause === null) {
            s.backoffMs = 0;
            job.resolve(res);
          } else if (job.attempts < 3 && Date.now() + pause.ms <= job.deadline) {
            // Not executed by GitHub: safe to retry once the pause is over.
            this.applyPause(s, pause.ms, pause.reason);
            this.enqueue(s, job);
          } else {
            this.applyPause(s, pause.ms, pause.reason);
            job.reject(new RateLimitError(`${pause.reason}; retry after ${new Date(Date.now() + pause.ms).toISOString()}`, Date.now() + pause.ms));
          }
        },
        (err) => {
          bucket.inFlight--;
          s.active--;
          job.reject(err);
        },
      )
      .finally(() => this.pump(s));
  }

  private applyPause(s: TokenState, ms: number, reason: string) {
    const until = Date.now() + ms;
    if (until > s.pausedUntil) {
      s.pausedUntil = until;
      s.pauseReason = reason;
    }
  }

  /** Update the buckets from response headers; return a pause when the response is a limit block. */
  private async observe(s: TokenState, resource: Resource, res: Response): Promise<{ ms: number; reason: string } | null> {
    const h = res.headers;
    const name = (h.get("x-ratelimit-resource") as Resource | null) ?? resource;
    const limit = num(h.get("x-ratelimit-limit"));
    const remaining = num(h.get("x-ratelimit-remaining"));
    const reset = num(h.get("x-ratelimit-reset"));
    if (limit !== null && remaining !== null && reset !== null && (name === "core" || name === "graphql" || name === "search")) {
      const b = s.bucket(name);
      b.limit = limit;
      b.remaining = remaining;
      b.resetAt = reset * 1000;
    }
    if (res.status !== 403 && res.status !== 429 && !(resource === "graphql" && (await graphqlRateLimited(res)))) return null;

    const retryAfter = num(h.get("retry-after"));
    if (retryAfter !== null) return { ms: retryAfter * 1000, reason: "secondary rate limit (retry-after)" };
    if (remaining === 0 && reset !== null) {
      return { ms: Math.max(0, reset * 1000 - Date.now()) + 1000, reason: `primary rate limit on ${name}` };
    }
    const body = res.status === 200 ? "rate_limited" : await res.clone().text().catch(() => "");
    if (/rate limit|abuse|rate_limited/i.test(body)) {
      s.backoffMs = Math.min(this.o.maxBackoffMs, s.backoffMs ? s.backoffMs * 2 : this.o.baseBackoffMs);
      return { ms: s.backoffMs, reason: "secondary rate limit (backoff)" };
    }
    return null;
  }
}

function num(v: string | null): number | null {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** GraphQL reports rate limiting as HTTP 200 with an error of type RATE_LIMITED. */
async function graphqlRateLimited(res: Response): Promise<boolean> {
  if (res.status !== 200 || !res.headers.get("content-type")?.includes("json")) return false;
  try {
    const body = (await res.clone().json()) as { errors?: { type?: string }[] };
    return Boolean(body.errors?.some((e) => e.type === "RATE_LIMITED"));
  } catch {
    return false;
  }
}
