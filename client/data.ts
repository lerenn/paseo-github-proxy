import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { discoverOwnersRpc, discoverReposRpc, activityRpc, appCredentialsClearRpc, appCredentialsSaveRpc, clearRpc, clientApiStatusRpc, clientTokenRpc, configGetRpc, configSaveRpc, overviewRpc, subscriptionRemoveRpc, subscriptionsRpc, webhookSecretRpc, webhookStatusRpc } from "../shared/contracts";
import type { Config } from "../shared/config";

const POLL_MS = 2000;

export function useOverviewData() {
  const overview = useRpc(overviewRpc);
  return useQuery({ queryKey: ["github-proxy", "overview"], queryFn: () => overview({}), refetchInterval: POLL_MS });
}

export function useActivityData() {
  const activity = useRpc(activityRpc);
  return useQuery({ queryKey: ["github-proxy", "activity"], queryFn: () => activity({ limit: 200 }), refetchInterval: POLL_MS });
}

/** The saved config and the GitHub Apps (key fingerprints only), and a `change` that saves an edit at once (the screen shows it before the save lands). */
export function useConfigData() {
  const get = useRpc(configGetRpc);
  const save = useRpc(configSaveRpc);
  const saveApp = useRpc(appCredentialsSaveRpc);
  const clearApp = useRpc(appCredentialsClearRpc);
  const clear = useRpc(clearRpc);
  const client = useQueryClient();
  const toast = useToast();
  const key = ["github-proxy", "config"];
  const query = useQuery({ queryKey: key, queryFn: () => get({}) });

  const mutation = useMutation({
    mutationFn: (config: Config) => save({ config }),
    onSuccess: ({ config }) => {
      client.setQueryData(key, (old: Awaited<ReturnType<typeof get>> | undefined) => (old ? { ...old, config } : old));
      void client.invalidateQueries({ queryKey: ["github-proxy", "overview"] });
    },
    onError: (error: Error) => toast.error(`Could not save: ${error.message}`),
  });
  const change = (update: (current: Config) => Config) => {
    const current = query.data?.config;
    if (!current) return;
    const next = update(current);
    client.setQueryData(key, (old: Awaited<ReturnType<typeof get>> | undefined) => (old ? { ...old, config: next } : old));
    mutation.mutate(next);
  };
  const refreshApps = (apps: Awaited<ReturnType<typeof saveApp>>["apps"]) => {
    client.setQueryData(key, (old: Awaited<ReturnType<typeof get>> | undefined) => (old ? { ...old, apps } : old));
    void client.invalidateQueries({ queryKey: ["github-proxy", "overview"] });
    void client.invalidateQueries({ queryKey: ["github-proxy", "owners"] });
  };
  const appSave = useMutation({
    mutationFn: saveApp,
    onSuccess: ({ apps }) => {
      refreshApps(apps);
      toast.show("GitHub App saved", { variant: "success" });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const appClear = useMutation({
    mutationFn: (id: string) => clearApp({ id }),
    onSuccess: ({ apps }) => {
      refreshApps(apps);
      toast.show("GitHub App removed");
    },
  });
  const secret = useRpc(webhookSecretRpc);
  /** Generates or clears an App's webhook secret; a generated value is in the result once. */
  const webhookSecret = useMutation({
    mutationFn: (input: { id: string; action: "generate" | "clear" }) => secret(input),
    onSuccess: ({ apps }) => refreshApps(apps),
    onError: (error: Error) => toast.error(error.message),
  });
  const clearData = useMutation({
    mutationFn: (what: "cache" | "activity") => clear({ what }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["github-proxy"] }),
  });
  return { config: query.data?.config ?? null, apps: query.data?.apps ?? null, loading: query.isLoading, error: query.error as Error | null, change, appSave, appClear, webhookSecret, clearData };
}

/** Owners the active source can reach (gh user and orgs, or the accounts the Apps are installed on). Never throws: a failure becomes `error`. */
export function useOwnerChoices(source: string, appCount = 0) {
  const owners = useRpc(discoverOwnersRpc);
  const q = useQuery({ queryKey: ["github-proxy", "owners", source, appCount], queryFn: () => owners({}), staleTime: 60_000, retry: false });
  return { owners: q.data?.owners ?? [], error: q.data?.error || (q.error ? (q.error as Error).message : ""), loading: q.isLoading };
}

/** Repositories of the allowed owners that the policy lets agents read. Refetched when the owners or source change. */
export function useRepoChoices(key: string) {
  const repos = useRpc(discoverReposRpc);
  const q = useQuery({ queryKey: ["github-proxy", "repos", key], queryFn: () => repos({}), staleTime: 60_000, retry: false });
  return { repos: q.data?.repos ?? [], errors: q.data?.errors ?? (q.error ? [(q.error as Error).message] : []), loading: q.isLoading };
}

export function useWebhookStatus() {
  const status = useRpc(webhookStatusRpc);
  return useQuery({ queryKey: ["github-proxy", "webhook"], queryFn: () => status({}), refetchInterval: POLL_MS });
}

export function useSubscriptions() {
  const list = useRpc(subscriptionsRpc);
  const remove = useRpc(subscriptionRemoveRpc);
  const client = useQueryClient();
  const key = ["github-proxy", "subscriptions"];
  const query = useQuery({ queryKey: key, queryFn: () => list({}), refetchInterval: POLL_MS * 3 });
  const unsubscribe = useMutation({ mutationFn: (id: string) => remove({ id }), onSuccess: (data) => client.setQueryData(key, data) });
  return { subscriptions: query.data?.subscriptions, unsubscribe };
}

export function useClientApi() {
  const status = useRpc(clientApiStatusRpc);
  const token = useRpc(clientTokenRpc);
  const client = useQueryClient();
  const key = ["github-proxy", "client-api"];
  const query = useQuery({ queryKey: key, queryFn: () => status({}), refetchInterval: POLL_MS });
  /** Generates or removes the bearer token; a generated value is in the result once. */
  const setToken = useMutation({ mutationFn: (action: "generate" | "clear") => token({ action }), onSuccess: () => void client.invalidateQueries({ queryKey: key }) });
  return { status: query.data, setToken };
}
