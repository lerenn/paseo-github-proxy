/** Per-agent opt-out of the GitHub lockout. The only convention shared with other plugins. */
export const PROXY_ENV = "PASEO_GITHUB_PROXY";

/** True when the agent asked to keep its own GitHub access (`PASEO_GITHUB_PROXY=off`). */
export function isOptedOut(env: Record<string, string | undefined> | undefined): boolean {
  const value = env?.[PROXY_ENV]?.trim().toLowerCase();
  return value === "off" || value === "0" || value === "false";
}

/** True when the agent asked for the proxy and lockout (`PASEO_GITHUB_PROXY=on`). */
export function isOptedIn(env: Record<string, string | undefined> | undefined): boolean {
  const value = env?.[PROXY_ENV]?.trim().toLowerCase();
  return value === "on" || value === "1" || value === "true";
}

export type LockoutScope = "opt-in" | "all";

/**
 * Whether a new agent gets the injection and lockout. With `opt-in` only agents created with
 * PASEO_GITHUB_PROXY=on do; with `all` every agent does unless it set PASEO_GITHUB_PROXY=off.
 */
export function lockoutApplies(scope: LockoutScope, env: Record<string, string | undefined> | undefined): boolean {
  return scope === "all" ? !isOptedOut(env) : isOptedIn(env);
}
