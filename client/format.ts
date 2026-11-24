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
