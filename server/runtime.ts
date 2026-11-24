import path from "node:path";
import { ActivityLog } from "./activity";
import { AppPool } from "./apps";
import { GhCliSource, type FetchFn } from "./auth";
import { ResponseCache } from "./cache";
import { GithubProxy } from "./proxy";
import { RateLimitTracker } from "./ratelimit";
import { ConfigStore, dataDir } from "./store";

export const nodeFetch: FetchFn = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}), signal: AbortSignal.timeout(30_000) as never });
  return { status: res.status, headers: res.headers, text: () => res.text() };
};

/** Everything the server entry wires together. */
export function createRuntime(dir = dataDir(), fetchFn: FetchFn = nodeFetch) {
  const store = new ConfigStore(dir);
  const cache = new ResponseCache(path.join(dir, "cache.json"));
  const tracker = new RateLimitTracker();
  const activity = new ActivityLog();
  const gh = new GhCliSource();
  const apps = new AppPool(store, fetchFn);
  const proxy = new GithubProxy({ config: () => store.get(), gh, apps, fetch: fetchFn, cache, tracker, activity });
  return { store, cache, tracker, activity, gh, apps, proxy, dispose: () => cache.flush() };
}
export type Runtime = ReturnType<typeof createRuntime>;
