import type { Operation, Policy } from "../shared/policy";

export interface Decision {
  allowed: boolean;
  /** Human reason for a refusal, naming the operation and the rule or default behind it. */
  reason?: string;
  refused: Operation[];
}

function matches(pattern: string, repo: string): number {
  const p = pattern.toLowerCase();
  if (p === "*") return 1;
  if (p === repo.toLowerCase()) return 3;
  if (p.endsWith("/*") && repo.toLowerCase().startsWith(p.slice(0, -1))) return 2;
  return 0;
}

/**
 * Effective operations for a repository: the defaults, then matching rules from least to most
 * specific adding their allows. Any deny from the defaults or a matching rule is final.
 */
export function effective(policy: Policy, repo: string | null, strict = false) {
  const allowed = new Set<Operation>(policy.allow);
  const denied = new Map<Operation, string>(policy.deny.map((op) => [op, "denied by default policy"]));
  const rules = policy.repos
    .map((r) => ({ r, score: repo ? matches(r.repo, repo) : r.repo === "*" ? 1 : 0 }))
    .filter((x) => strict || x.score > 0)
    .sort((a, b) => a.score - b.score);
  for (const { r, score } of rules) {
    // Strict (repository unknown): only global rules can allow, but every rule can deny.
    if (!strict || score > 0) for (const op of r.allow) allowed.add(op);
    for (const op of r.deny) denied.set(op, `denied by the rule for ${r.repo}`);
  }
  return { allowed, denied };
}

/**
 * With `strict`, the call's repository is unknown (GraphQL mutations address objects by id), so a
 * deny in any repository rule applies and only global rules can allow.
 */
export function decide(policy: Policy, repo: string | null, ops: Operation[], strict = false): Decision {
  const { allowed, denied } = effective(policy, repo, strict);
  const refused: Operation[] = [];
  const why: string[] = [];
  for (const op of ops) {
    const rule = denied.get(op);
    if (rule) {
      refused.push(op);
      why.push(`${op}: ${rule}`);
    } else if (!allowed.has(op)) {
      refused.push(op);
      why.push(`${op}: not allowed by the write policy`);
    }
  }
  return refused.length
    ? { allowed: false, refused, reason: `Refused by the GitHub proxy write policy for ${repo ?? "this call"}${strict ? " (repository unknown, so every repository rule applies)" : ""} (${why.join("; ")}). Nothing was sent to GitHub.` }
    : { allowed: true, refused };
}
