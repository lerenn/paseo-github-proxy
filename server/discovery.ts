import { evaluate } from "./policy";
import { resolveApp, type AppEntry, type Config, type SourceId } from "../shared/config";

/** A read-only GET against the GitHub API through the active source, cached; the proxy supplies it. `via.app` forces one GitHub App (by id). */
export type LookupFn = (path: string, query?: Record<string, string | number>, via?: { app: string }) => Promise<unknown>;

const MAX_OWNERS = 12;
const PER_PAGE = 100;

const logins = (items: unknown): string[] => (Array.isArray(items) ? items.map((i) => (i as { login?: unknown })?.login).filter((l): l is string => typeof l === "string") : []);
const unique = (items: string[]): string[] => [...new Set(items.map((s) => s.toLowerCase()))].sort();

/**
 * Owners the active source can reach: the gh user and their organizations, or, with GitHub Apps, the accounts each App is
 * installed on (every App asked on its own, so an owner is found through the App that can see it). An App that fails is
 * reported without hiding the others.
 */
export async function discoverOwners(lookup: LookupFn, source: SourceId, apps: AppEntry[] = []): Promise<{ owners: string[]; error: string }> {
  try {
    if (source === "app") {
      if (apps.length === 0) return { owners: [], error: "No GitHub App is configured." };
      const owners: string[] = [];
      const errors: string[] = [];
      for (const app of apps) {
        try {
          const data = (await lookup("/installation/repositories", { per_page: PER_PAGE }, { app: app.id })) as { repositories?: { owner?: { login?: string } }[] };
          owners.push(...logins((data.repositories ?? []).map((r) => r.owner)));
        } catch (error) {
          errors.push(`${app.label}: ${(error as Error).message}`);
        }
      }
      return { owners: unique(owners), error: errors.join("; ") };
    }
    const owners = [...logins([await lookup("/user")]), ...logins(await lookup("/user/orgs", { per_page: PER_PAGE }).catch(() => []))];
    return { owners: unique(owners), error: "" };
  } catch (error) {
    return { owners: [], error: (error as Error).message };
  }
}

/**
 * Repositories (`owner/name`) of the allowed owners that the policy lets an agent read, first page per owner.
 * With `*` allowed, the discovered owners stand in. A failing owner is reported and skipped.
 */
export async function discoverRepos(lookup: LookupFn, config: Config, discovered: string[], apps: AppEntry[] = []): Promise<{ repos: string[]; errors: string[] }> {
  const explicit = config.allowedOwners.map((o) => o.trim().toLowerCase()).filter((o) => o && o !== "*");
  const owners = (config.allowedOwners.map((o) => o.trim()).includes("*") ? [...explicit, ...discovered] : explicit).slice(0, MAX_OWNERS);
  const repos: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const readable = (full: string) => evaluate(config.policy, full, ["read"]).allowed;
  const add = (full: string) => {
    const key = full.toLowerCase();
    if (!seen.has(key) && readable(full)) {
      seen.add(key);
      repos.push(full);
    }
  };
  // Installation repositories are listed once per App, and an owner is read through the App that serves it.
  const installation = new Map<string, string[]>();
  for (const owner of [...new Set(owners)]) {
    if (!readable(`${owner}/x`) && config.policy.rules.every((r) => r.effect !== "allow")) {
      continue;
    }
    try {
      if (config.activeSource === "app") {
        const app = resolveApp(apps, owner);
        if (!app) throw new Error("no GitHub App serves this owner");
        if (!installation.has(app.id)) {
          const data = (await lookup("/installation/repositories", { per_page: PER_PAGE }, { app: app.id })) as { repositories?: { full_name?: string }[] };
          installation.set(app.id, (data.repositories ?? []).map((r) => r.full_name ?? "").filter(Boolean));
        }
        installation.get(app.id)!.filter((f) => f.toLowerCase().startsWith(`${owner}/`)).forEach(add);
      } else {
        let list: unknown;
        try {
          list = await lookup(`/orgs/${encodeURIComponent(owner)}/repos`, { per_page: PER_PAGE, sort: "pushed" });
        } catch {
          list = await lookup(`/users/${encodeURIComponent(owner)}/repos`, { per_page: PER_PAGE, sort: "pushed" });
        }
        (Array.isArray(list) ? list : []).map((r) => (r as { full_name?: string })?.full_name ?? "").filter(Boolean).forEach(add);
      }
    } catch (error) {
      errors.push(`${owner}: ${(error as Error).message}`);
    }
  }
  return { repos, errors };
}
