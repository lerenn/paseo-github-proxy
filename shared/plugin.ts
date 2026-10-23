/** Per-agent opt-out of the GitHub lockout. The only convention shared with other plugins. */
export const PROXY_ENV = "PASEO_GITHUB_PROXY";

/** True when the agent asked to keep its own GitHub access (`PASEO_GITHUB_PROXY=off`). */
export function isOptedOut(env: Record<string, string | undefined> | undefined): boolean {
  const value = env?.[PROXY_ENV]?.trim().toLowerCase();
  return value === "off" || value === "0" || value === "false";
}
