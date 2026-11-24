import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { discoverOwnersRpc, discoverReposRpc, activityRpc, appCredentialsClearRpc, appCredentialsSaveRpc, clearRpc, configGetRpc, configSaveRpc, overviewRpc } from "../shared/contracts";
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

/** The saved config and App credentials view, and a `change` that saves an edit at once (the screen shows it before the save lands). */
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
  const refreshApp = (app: Awaited<ReturnType<typeof saveApp>>["app"]) => {
    client.setQueryData(key, (old: Awaited<ReturnType<typeof get>> | undefined) => (old ? { ...old, app } : old));
    void client.invalidateQueries({ queryKey: ["github-proxy", "overview"] });
  };
  const appSave = useMutation({
    mutationFn: saveApp,
    onSuccess: ({ app }) => {
      refreshApp(app);
      toast.show("GitHub App credentials saved", { variant: "success" });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const appClear = useMutation({
    mutationFn: () => clearApp({}),
    onSuccess: ({ app }) => {
      refreshApp(app);
      toast.show("GitHub App credentials removed");
    },
  });
  const clearData = useMutation({
    mutationFn: (what: "cache" | "activity") => clear({ what }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["github-proxy"] }),
  });
  return { config: query.data?.config ?? null, app: query.data?.app ?? null, loading: query.isLoading, error: query.error as Error | null, change, appSave, appClear, clearData };
}

/** Owners the active source can reach (gh user and orgs, or the App installation account). Never throws: a failure becomes `error`. */
export function useOwnerChoices(source: string) {
  const owners = useRpc(discoverOwnersRpc);
  const q = useQuery({ queryKey: ["github-proxy", "owners", source], queryFn: () => owners({}), staleTime: 60_000, retry: false });
  return { owners: q.data?.owners ?? [], error: q.data?.error || (q.error ? (q.error as Error).message : ""), loading: q.isLoading };
}

/** Repositories of the allowed owners that the policy lets agents read. Refetched when the owners or source change. */
export function useRepoChoices(key: string) {
  const repos = useRpc(discoverReposRpc);
  const q = useQuery({ queryKey: ["github-proxy", "repos", key], queryFn: () => repos({}), staleTime: 60_000, retry: false });
  return { repos: q.data?.repos ?? [], errors: q.data?.errors ?? (q.error ? [(q.error as Error).message] : []), loading: q.isLoading };
}
