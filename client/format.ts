import type { SourceId } from "../shared/config";

/** Whether the Client API card says git is left alone: the setup is on and the helper is in place, but no GitHub App could issue a token. */
export const gitLeftAlone = (injectEnv: boolean, status: { helperFound: boolean; gitAvailable: boolean } | null | undefined): boolean => injectEnv && !!status && status.helperFound && !status.gitAvailable;

export type BehaviourWarning = "clientApiOff" | "clientApiNoInject";

/** Warnings for the Behaviour card: a forbid rule is on but agents have no policy-controlled path for gh and git. */
export function behaviourWarnings(c: { forbidRawGithub: boolean; blockRawGithub: boolean; clientApi: { enabled: boolean; injectEnv: boolean } }): BehaviourWarning[] {
  if (!c.forbidRawGithub && !c.blockRawGithub) return [];
  if (!c.clientApi.enabled) return ["clientApiOff"];
  return c.clientApi.injectEnv ? [] : ["clientApiNoInject"];
}
/** "in 4m 12s", "in 59s", "now": time left until an epoch ms. */
export function countdown(until: number, now: number): string {
  const s = Math.max(0, Math.ceil((until - now) / 1000));
  if (s === 0) return "now";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `in ${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `in ${m}m ${String(sec).padStart(2, "0")}s`;
  return `in ${sec}s`;
}

export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** "2 signature · 1 owner · 0 duplicate": why deliveries were rejected. */
export function rejectedBreakdown(e: { badSignature: number; badOwner: number; duplicate: number }): string {
  return `${e.badSignature} signature · ${e.badOwner} owner · ${e.duplicate} duplicate`;
}

/** Comma, space or newline separated list → trimmed unique non-empty items. */
export function splitList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

/** Adds an alpha channel to a #rgb or #rrggbb colour; the colour itself for any other format. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return color;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return `#${full}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

/** The preset whose allowed actions equal this list, or "custom". */
export function presetOf(defaultAllow: readonly string[], presets: Record<string, readonly string[]>): string {
  const sorted = [...defaultAllow].sort().join(",");
  return Object.entries(presets).find(([, allow]) => [...allow].sort().join(",") === sorted)?.[0] ?? "custom";
}

/** Checks or unchecks `value`. Checking the `exclusive` value (such as `*`) clears the rest; checking anything else clears it. */
export function toggleChecked(selected: readonly string[], value: string, exclusive?: string): string[] {
  if (selected.includes(value)) return selected.filter((s) => s !== value);
  if (exclusive && value === exclusive) return [value];
  return [...selected.filter((s) => s !== exclusive), value];
}

/** "None", the single item, or "3 selected"; `all` names the exclusive value's meaning. */
export function summarize(selected: readonly string[], opts: { none: string; exclusive?: string; all?: string }): string {
  if (selected.length === 0) return opts.none;
  if (opts.exclusive && selected.includes(opts.exclusive)) return opts.all ?? "All";
  if (selected.length === 1) return selected[0]!;
  return `${selected.length} selected`;
}

export const SOURCE_OPTIONS: { id: SourceId; title: string; text: string; icon: string }[] = [
  { id: "gh", title: "Local gh CLI", text: "Your own GitHub login on this machine.", icon: "Terminal" },
  { id: "app", title: "GitHub Apps", text: "Dedicated App installations, one per owner, each with its own rate limit.", icon: "KeyRound" },
];


/** Compact summary of an App for its collapsed row: the owner it serves (or a count) and its App ID. */
export function appSummary(app: { owners: string[]; appId: string; default: boolean }): string {
  const owners = app.owners.length === 1 ? app.owners[0]! : app.owners.length > 1 ? `${app.owners.length} owners` : app.default ? "Rest" : "No owner";
  return app.appId ? `${owners} · App ${app.appId}` : owners;
}

/** Opens or closes one entry of the set of open ids. */
export function toggleOpen(open: readonly string[], id: string): string[] {
  return open.includes(id) ? open.filter((x) => x !== id) : [...open, id];
}

/**
 * The rate-limit sources to show on the Overview: the active source (every App when it is "app"), plus the other
 * source only when the rate-limit fallback is on, since that is the only way it can serve a call.
 */
export function visibleSources<T extends { active: boolean }>(sources: readonly T[], fallback: boolean): T[] {
  return sources.filter((s) => s.active || fallback);
}
