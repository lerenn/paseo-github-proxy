import { ACTION_INFO, PLAIN_GIT_ACTIONS, type Action } from "../shared/actions";
import type { Policy, Rule } from "../shared/config";

export interface Decision {
  allowed: boolean;
  /** The action that decided: the first one denied, or the last one checked when all are allowed. */
  action: Action | null;
  /** The rule that decided, or null when the default policy did. */
  rule: { index: number; rule: Rule } | null;
  /** A message addressed to the agent. Empty when allowed. */
  message: string;
}

// Patterns such as acme/<star>, <star>/repo or acme/web-<star>: case-insensitive, a star stays inside one segment, a lone star matches everything.
export function matchRepo(pattern: string, repo: string): boolean {
  const p = pattern.trim().toLowerCase();
  const r = repo.trim().toLowerCase();
  if (p === "*") return true;
  if (!p) return false;
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(r);
}

export function ruleCovers(rule: Rule, repo: string, action: Action): boolean {
  const repoMatch = rule.repos.length === 0 ? true : rule.repos.some((pattern) => matchRepo(pattern, repo));
  const actionMatch = rule.actions.length === 0 ? true : rule.actions.includes("*") || rule.actions.includes(action);
  return repoMatch && actionMatch;
}

const GIT_NOTE = " Plain git commands are not affected by this policy (use them only if your project instructions allow git).";

/** How to enable an action: names it and where, so the agent can ask the user precisely. */
function enableHint(action: Action, repo: string, rule: { index: number } | null): string {
  const where = rule ? `${repo || "this target"} (edit or remove rule #${rule.index + 1})` : "the default policy";
  return ` Do not retry this call. Ask the user to enable \`${action}\` for ${where} in the Policy tab of the GitHub Proxy plugin.${PLAIN_GIT_ACTIONS.includes(action) ? GIT_NOTE : ""}`;
}

function describeRule(index: number, rule: Rule): string {
  const scope = rule.repos.length ? rule.repos.join(", ") : "*";
  const what = rule.actions.length ? rule.actions.join(", ") : "*";
  return `rule #${index + 1} (${rule.effect} ${what} on ${scope})`;
}

/**
 * Decides one action on one repo. A matching deny rule always wins, then a matching allow rule, then the
 * default policy (`defaultAllow`). The message tells the agent which rule said no, so it stops retrying.
 */
export function evaluateAction(policy: Policy, repo: string, action: Action): Decision {
  let allowRule: { index: number; rule: Rule } | null = null;
  for (let index = 0; index < policy.rules.length; index++) {
    const rule = policy.rules[index]!;
    if (!ruleCovers(rule, repo, action)) continue;
    if (rule.effect === "deny") {
      const why = rule.reason ? ` Reason: ${rule.reason}` : "";
      return {
        allowed: false,
        action,
        rule: { index, rule },
        message: `Denied by ${describeRule(index, rule)}: "${ACTION_INFO[action].label}" is not allowed on ${repo || "this target"} (action \`${action}\`).${why}${enableHint(action, repo, { index })}`,
      };
    }
    allowRule ??= { index, rule };
  }
  if (allowRule) return { allowed: true, action, rule: allowRule, message: "" };
  if (policy.defaultAllow.includes(action)) return { allowed: true, action, rule: null, message: "" };
  return {
    allowed: false,
    action,
    rule: null,
    message: `Denied by the default policy (${policy.preset.replace("_", "-")}): "${ACTION_INFO[action].label}" is not allowed on ${repo || "this target"} (action \`${action}\`).${enableHint(action, repo, null)}`,
  };
}

/** Every action must be allowed. */
export function evaluate(policy: Policy, repo: string, actions: readonly Action[]): Decision {
  let last: Decision = { allowed: true, action: null, rule: null, message: "" };
  for (const action of actions) {
    last = evaluateAction(policy, repo, action);
    if (!last.allowed) return last;
  }
  return last;
}

/** Owner allowlist: exact, case-insensitive; `*` allows every owner; an empty list refuses all. */
export function ownerAllowed(allowed: readonly string[], owner: string): boolean {
  if (!owner) return false;
  const set = new Set(allowed.map((o) => o.trim().toLowerCase()).filter(Boolean));
  return set.has("*") || set.has(owner.toLowerCase());
}

export function ownerDenial(allowed: readonly string[], owner: string): string {
  if (allowed.filter((o) => o.trim()).length === 0) {
    return `Denied: no owner is allowed yet. The user must add "${owner || "the owner"}" to Allowed owners in GitHub Proxy → Auth. Do not retry.`;
  }
  return `Denied: the owner "${owner}" is not in the allowed owners list (${allowed.join(", ")}). Do not retry; ask the user to add it in GitHub Proxy → Auth.`;
}
