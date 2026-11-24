import { appName, type AppEntry } from "../shared/config";
import { AppSource, type AppCredentials, type FetchFn, type TokenSource } from "./auth";

export { resolveApp } from "../shared/config";

/** The configured GitHub Apps and a token source for each. */
export interface AppDirectory {
  list(): AppEntry[];
  /** The token source of one App (its own JWT and installation-token cache). */
  source(id: string): TokenSource;
}

/** Credential identity of an App in rate-limit and cache keys. */
export const appKey = (id: string): string => `app:${id}`;

/** One `AppSource` per App, created on demand; `forget` drops it (and its token) after the App changes. */
export class AppPool implements AppDirectory {
  private readonly sources = new Map<string, AppSource>();

  constructor(
    private readonly store: { apps(): AppEntry[]; appCredentials(id: string): AppCredentials | null },
    private readonly fetchFn: FetchFn,
    private readonly clock: () => number = Date.now,
    private readonly apiBase = "https://api.github.com",
  ) {}

  list(): AppEntry[] {
    return this.store.apps();
  }

  source(id: string): AppSource {
    let s = this.sources.get(id);
    if (!s) {
      const label = () => `GitHub App "${(() => { const a = this.store.apps().find((x) => x.id === id); return a ? appName(a) : id; })()}"`;
      s = new AppSource(() => this.store.appCredentials(id), this.fetchFn, this.clock, this.apiBase, label);
      this.sources.set(id, s);
    }
    return s;
  }

  forget(id: string): void {
    this.sources.get(id)?.invalidate();
    this.sources.delete(id);
  }
}
