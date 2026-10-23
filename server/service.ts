import type { OwnerStatus } from "../shared/rpc";
import { GitHubClient, GitHubError } from "./github";
import { scrub, TokenStore, tokenKey } from "./tokens";

/** Backs the screen's RPCs: tokens (write-only), budget status and refresh. */
export class ProxyService {
  private readonly errors = new Map<string, string>();

  constructor(
    readonly client: GitHubClient,
    private readonly tokens: TokenStore,
    private readonly endpoint: () => { url: string | null; error: string | null } = () => ({ url: null, error: null }),
  ) {}

  status(): { owners: OwnerStatus[]; cache: ReturnType<GitHubClient["cache"]["stats"]>; endpoint: { url: string | null; error: string | null } } {
    const owners = this.tokens.owners();
    const keyOf = new Map(owners.map((o) => [o, tokenKey(this.tokens.get(o) ?? "")]));
    return {
      owners: owners.map((owner) => ({
        owner,
        sharesBudgetWith: owners.filter((o) => o !== owner && keyOf.get(o) === keyOf.get(owner)),
        budget: this.client.limiter.snapshot(keyOf.get(owner)!),
        error: this.errors.get(owner) ?? null,
      })),
      cache: this.client.cache.stats(),
      endpoint: this.endpoint(),
    };
  }

  async refresh() {
    const seen = new Set<string>();
    for (const owner of this.tokens.owners()) {
      const key = this.client.budgetKey(owner);
      if (seen.has(key)) continue;
      seen.add(key);
      await this.check(owner);
    }
    return this.status();
  }

  /** Validate and store. A token GitHub rejects is not kept. */
  async setToken(owner: string, token: string) {
    const previous = this.tokens.get(owner);
    this.tokens.set(owner, token);
    try {
      await this.client.refreshBudget(owner);
      this.errors.delete(owner.toLowerCase());
    } catch (err) {
      if (previous) this.tokens.set(owner, previous);
      else this.tokens.clear(owner);
      throw new Error(scrub(describe(err), token.trim()));
    }
  }

  clearToken(owner: string) {
    this.tokens.clear(owner);
    this.errors.delete(owner.toLowerCase());
  }

  private async check(owner: string) {
    try {
      await this.client.refreshBudget(owner);
      this.errors.delete(owner);
    } catch (err) {
      this.errors.set(owner, describe(err));
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof GitHubError && err.status === 401) return "GitHub rejected this token (401 bad credentials)";
  return err instanceof Error ? err.message : String(err);
}
