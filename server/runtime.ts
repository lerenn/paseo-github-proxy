import path from "node:path";
import { ActivityLog } from "./activity";
import { AppPool } from "./apps";
import { GhCliSource, type FetchFn } from "./auth";
import { ResponseCache } from "./cache";
import { staleKeyTest } from "./events";
import { GithubProxy } from "./proxy";
import { RateLimitTracker } from "./ratelimit";
import { ConfigStore, dataDir } from "./store";
import { SubscriptionStore } from "./subscriptions";
import { WakeService, type AgentSender } from "./wakeups";
import { WebhookReceiver, WebhookServer } from "./webhook";

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
  const subscriptions = new SubscriptionStore(path.join(dir, "subscriptions.json"));

  // The Paseo SDK handle comes with every hook, tool and RPC context; keep the latest one for the webhook listener.
  let paseo: AgentSender | null = null;
  const wake = new WakeService({ subs: subscriptions, paseo: () => paseo, log: (m) => console.error(`[github-proxy] ${m}`) });
  const receiver = new WebhookReceiver({
    secrets: () => store.webhookSecrets(),
    apps: () => store.apps(),
    // Invalidation first (reads are fresh as soon as the event is accepted), then the wake-ups.
    onEvent: async (parsed) => {
      cache.invalidateWhere(staleKeyTest(parsed));
      return parsed.wake ? await wake.dispatch(parsed.wake) : 0;
    },
    log: (m) => console.error(`[github-proxy] ${m}`),
  });
  const webhooks = new WebhookServer(receiver, () => store.webhookSecrets().length, (m) => console.error(`[github-proxy] ${m}`));

  return {
    store, cache, tracker, activity, gh, apps, proxy, subscriptions, wake, webhooks,
    /** Remembers the SDK handle of the context a hook, tool or RPC runs in. */
    capturePaseo(handle: AgentSender | undefined): void {
      if (handle) paseo = handle;
    },
    dispose: () => {
      cache.flush();
      void webhooks.stop();
    },
  };
}
export type Runtime = ReturnType<typeof createRuntime>;
