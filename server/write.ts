import type { Policy } from "../shared/policy";
import type { AuditLog } from "./audit";
import { classifyGraphql, classifyRest, graphqlMutationFields } from "./classify";
import type { GitHubClient } from "./github";
import { GitHubError } from "./github";
import { decide } from "./policy";

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export interface WriteContext {
  agentId?: string | null;
}

/**
 * The only way a write reaches GitHub. Classifies the call, checks the policy, audits the
 * outcome, and only then sends it. Refused writes are never sent.
 */
export class WriteGate {
  constructor(
    private readonly deps: { client: GitHubClient; policy: () => Promise<Policy>; audit: AuditLog },
  ) {}

  async rest(ctx: WriteContext, req: { method: "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown; summary: string }) {
    const { repo, ops } = classifyRest(req.method, req.path, req.body);
    const owner = repo?.split("/")[0] ?? ownerFromPath(req.path);
    return this.run(ctx, repo, ops, req.summary, owner, () => this.deps.client.rest({ owner: owner!, method: req.method, path: req.path, body: req.body, priority: "interactive" }).then((r) => ({ status: r.status, data: r.data })));
  }

  async graphql(ctx: WriteContext, req: { owner: string; query: string; variables?: Record<string, unknown> }) {
    const fields = graphqlMutationFields(req.query) ?? [];
    const ops = classifyGraphql(fields);
    return this.run(ctx, null, ops, `GraphQL mutation ${fields.join(", ") || "(unparsed)"}`, req.owner, async () => ({
      status: 200,
      data: await this.deps.client.graphql({ owner: req.owner, query: req.query, variables: req.variables, priority: "interactive" }),
    }), true);
  }

  private async run(
    ctx: WriteContext,
    repo: string | null,
    ops: ReturnType<typeof classifyRest>["ops"],
    summary: string,
    owner: string | undefined,
    send: () => Promise<{ status: number; data: unknown }>,
    strict = false,
  ) {
    const entry = { agentId: ctx.agentId ?? null, repo, ops, summary };
    const decision = decide(await this.deps.policy(), repo, ops, strict);
    if (!decision.allowed) {
      this.deps.audit.record({ ...entry, decision: "refused", detail: decision.reason ?? null, status: null });
      throw new PolicyError(decision.reason!);
    }
    if (!owner) {
      this.deps.audit.record({ ...entry, decision: "refused", detail: "cannot tell which owner's token to use", status: null });
      throw new PolicyError("Cannot tell which owner's token to use for this write.");
    }
    try {
      const res = await send();
      this.deps.audit.record({ ...entry, decision: "allowed", detail: null, status: res.status });
      return res.data;
    } catch (err) {
      this.deps.audit.record({
        ...entry,
        decision: "allowed",
        detail: err instanceof Error ? err.message : String(err),
        status: err instanceof GitHubError ? err.status : null,
      });
      throw err;
    }
  }
}

function ownerFromPath(path: string): string | undefined {
  return path.match(/^\/(?:repos|orgs|users)\/([^/]+)/)?.[1];
}
