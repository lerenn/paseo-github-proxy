import type { Operation } from "../shared/policy";

export interface Classified {
  /** `owner/name`, or null when the call is not about one repository. */
  repo: string | null;
  /** Every operation the call needs. All must be allowed. */
  ops: Operation[];
}

const ADMIN_REPO_PARTS = /^(hooks|keys|collaborators|invitations|rulesets|environments|actions\/(secrets|variables|permissions|runners|oidc)|dependabot\/secrets|codespaces\/secrets|branches\/[^/]+\/protection|autolinks|pages|transfer|rename|security-advisories|vulnerability-alerts|automated-security-fixes|teams|topics|dispatches)(\/|$)/;

/** What a REST write needs. Unknown shapes need `other`, which is refused unless allowed. */
export function classifyRest(method: string, rawPath: string, body: unknown): Classified {
  const m = method.toUpperCase();
  const pathName = rawPath.split("?")[0].replace(/\/+$/, "");
  const repoMatch = pathName.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (!repoMatch) return { repo: null, ops: [/^\/(orgs|user|users|enterprises|app)\b/.test(pathName) ? "admin" : "other"] };
  const repo = `${repoMatch[1]}/${repoMatch[2]}`.toLowerCase();
  const rest = repoMatch[3] ?? "";
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const done = (...ops: Operation[]): Classified => ({ repo, ops });

  if (rest === "") return done(m === "DELETE" || m === "PATCH" || m === "PUT" ? "admin" : "other");
  if (ADMIN_REPO_PARTS.test(rest)) return done("admin");

  let x: RegExpMatchArray | null;
  if (m === "POST" && /^issues\/\d+\/comments$/.test(rest)) return done("comment");
  if ((m === "PATCH") && /^issues\/comments\/\d+$/.test(rest)) return done("comment");
  if (m === "DELETE" && /^(issues|pulls)\/comments\/\d+$/.test(rest)) return done("comment.delete");
  if (m === "POST" && /^pulls\/\d+\/comments(\/\d+\/replies)?$/.test(rest)) return done("comment");
  if (m === "PATCH" && /^pulls\/comments\/\d+$/.test(rest)) return done("comment");
  if (m === "POST" && rest === "pulls") return done("pr.create");
  if (m === "PUT" && /^pulls\/\d+\/merge$/.test(rest)) return done("pr.merge");
  if (m === "PUT" && /^pulls\/\d+\/update-branch$/.test(rest)) return done("pr.update");
  if ((x = rest.match(/^pulls\/\d+$/)) && m === "PATCH") {
    const ops = new Set<Operation>();
    if ("state" in b) ops.add("pr.close");
    if (Object.keys(b).some((k) => k !== "state")) ops.add("pr.update");
    return done(...(ops.size ? ops : ["pr.update" as const]));
  }
  if (/^issues\/\d+\/labels(\/.*)?$/.test(rest) && ["POST", "PUT", "DELETE"].includes(m)) return done("label");
  if (m === "POST" && /^labels$/.test(rest)) return done("label");
  if (/^pulls\/\d+\/requested_reviewers$/.test(rest) && ["POST", "DELETE"].includes(m)) return done("review.request");
  if (m === "POST" && /^pulls\/\d+\/reviews$/.test(rest)) {
    const event = String(b.event ?? "").toUpperCase();
    return done(event === "APPROVE" || event === "REQUEST_CHANGES" ? "review.submit" : "comment");
  }
  if (m === "POST" && /^pulls\/\d+\/reviews\/\d+\/events$/.test(rest)) return done("review.submit");
  if (m === "PUT" && /^pulls\/\d+\/reviews\/\d+\/dismissals$/.test(rest)) return done("review.submit");
  if (m === "POST" && rest === "issues") {
    return done("issue.create", ...(Array.isArray(b.labels) && b.labels.length ? (["label"] as const) : []));
  }
  if (m === "PATCH" && /^issues\/\d+$/.test(rest)) {
    // The issues endpoint also edits and closes pull requests, so those need the pull request operations too.
    const ops = new Set<Operation>(["issue.update"]);
    if ("state" in b) ops.add("pr.close");
    if ("title" in b || "body" in b || "base" in b) ops.add("pr.update");
    if ("labels" in b) ops.add("label");
    return done(...ops);
  }
  if (m === "DELETE" && /^git\/refs\//.test(rest)) return done("branch.delete");
  if (m === "POST" && rest === "releases") return done("release.create");
  if (m === "POST" && rest === "git/refs") return done("ref.create");
  if (m === "PUT" && /^contents\/.+/.test(rest)) return done("contents.write");
  return done("other");
}

/** Root fields of GraphQL mutations: `mutation { a: addComment(...) { ... } }` gives `addComment`. */
export function graphqlMutationFields(query: string): string[] | null {
  const src = query.replace(/#[^\n]*/g, " ").replace(/"""[\s\S]*?"""/g, " ").replace(/"(?:\\.|[^"\\])*"/g, '""');
  const out: string[] = [];
  let mutations = 0;
  let depth = 0;
  let paren = 0;
  let inMutation = false;
  const tokens = src.match(/[{}()]|[A-Za-z_]\w*|[^\s{}()A-Za-z_]+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "(") paren++;
    else if (t === ")") paren--;
    else if (paren > 0) continue;
    else if (t === "{") {
      depth++;
    } else if (t === "}") {
      depth--;
      if (depth === 0) inMutation = false;
    } else if (depth === 0 && t === "mutation") {
      inMutation = true;
      mutations++;
    } else if (inMutation && depth === 1 && /^[A-Za-z_]/.test(t)) {
      // alias: field(...) -> take the field name after the colon.
      const field = tokens[i + 1] === ":" ? tokens[i + 2] : t;
      if (tokens[i + 1] === ":") i += 2;
      out.push(field);
      // Skip this field's arguments and selection set at depth 1 handled by depth tracking.
    }
  }
  if (mutations === 0) return null;
  return out;
}

const GRAPHQL_OPS: Record<string, Operation> = {
  addComment: "comment",
  updateIssueComment: "comment",
  addPullRequestReviewComment: "comment",
  addPullRequestReviewThreadReply: "comment",
  deleteIssueComment: "comment.delete",
  createPullRequest: "pr.create",
  updatePullRequest: "pr.update",
  markPullRequestReadyForReview: "pr.update",
  convertPullRequestToDraft: "pr.update",
  closePullRequest: "pr.close",
  reopenPullRequest: "pr.close",
  mergePullRequest: "pr.merge",
  enablePullRequestAutoMerge: "pr.merge",
  disablePullRequestAutoMerge: "pr.merge",
  enqueuePullRequest: "pr.merge",
  addLabelsToLabelable: "label",
  removeLabelsFromLabelable: "label",
  requestReviews: "review.request",
  addPullRequestReview: "review.submit",
  submitPullRequestReview: "review.submit",
  dismissPullRequestReview: "review.submit",
  createIssue: "issue.create",
  updateIssue: "issue.update",
  closeIssue: "issue.update",
  reopenIssue: "issue.update",
  deleteRef: "branch.delete",
  createRef: "ref.create",
  createCommitOnBranch: "contents.write",
};

/** What a GraphQL mutation document needs. The repository is not knowable from the document. */
export function classifyGraphql(fields: string[]): Operation[] {
  if (fields.length === 0) return ["other"];
  return [...new Set(fields.map((f): Operation => GRAPHQL_OPS[f] ?? "other"))];
}
