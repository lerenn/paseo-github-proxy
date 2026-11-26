import type { Action } from "../shared/actions";
import { canonicalRestPath } from "./path";

export interface Classified {
  /** Owner/repo, or "" when the path has no repository. */
  repo: string;
  /** Owners the call touches (for the allowlist). */
  owners: string[];
  /** The actions the policy must allow. */
  actions: Action[];
  /** Why the call cannot be scoped to an owner, when that is so. */
  unscoped?: string;
}

const REPO_PATH = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/;

function searchOwners(query: string): { owners: string[]; scoped: boolean } {
  const q = new URLSearchParams(query).get("q") ?? "";
  const owners: string[] = [];
  for (const m of q.matchAll(/\b(?:repo|org|user):("?)([^\s"]+)\1/gi)) {
    const value = m[2] ?? "";
    owners.push(value.split("/")[0]!.toLowerCase());
  }
  return { owners, scoped: owners.length > 0 };
}

/** Maps a REST write to the specific actions it performs (on top of generic_api_write). */
function restWriteActions(method: string, rest: string, body: unknown): Action[] {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const edit = method === "PATCH" || method === "PUT" || method === "POST" || method === "DELETE";
  if (method === "POST" && /^\/issues$/.test(rest)) return ["create_issue"];
  if (method === "POST" && /^\/(issues|pulls)\/\d+\/comments$/.test(rest)) return ["comment"];
  if (method === "POST" && /^\/pulls\/\d+\/comments\/\d+\/replies$/.test(rest)) return ["comment"];
  if (method === "POST" && /^\/pulls\/\d+\/reviews(\/\d+\/events)?$/.test(rest)) return ["review"];
  if (method === "POST" && /^\/pulls$/.test(rest)) return ["create_pr"];
  if ((method === "PATCH" || method === "PUT") && /^\/(pulls|issues)\/\d+$/.test(rest)) return ["update_pr"];
  // Labels, assignees, lock, reviewers, branch update and comment edits are all edits of an issue or a pull request.
  if (edit && /^\/issues\/\d+\/(labels|assignees)(\/[^/]+)?$/.test(rest)) return ["update_pr"];
  if ((method === "PUT" || method === "DELETE") && /^\/issues\/\d+\/lock$/.test(rest)) return ["update_pr"];
  if ((method === "POST" || method === "DELETE") && /^\/pulls\/\d+\/requested_reviewers$/.test(rest)) return ["update_pr"];
  if (method === "PUT" && /^\/pulls\/\d+\/update-branch$/.test(rest)) return ["update_pr"];
  if ((method === "PATCH" || method === "DELETE") && /^\/(issues|pulls)\/comments\/\d+$/.test(rest)) return ["update_pr"];
  if (method === "PUT" && /^\/pulls\/\d+\/merge$/.test(rest)) return ["merge"];
  if (method === "POST" && /^\/merges$/.test(rest)) return ["merge"];
  if (method === "POST" && /^\/merge-upstream$/.test(rest)) return ["merge"];
  if (method === "DELETE" && /^\/git\/refs\//.test(rest)) return ["delete_branch"];
  if (method === "POST" && /^\/git\/refs$/.test(rest)) return ["create_branch"];
  if (method === "PATCH" && /^\/git\/refs\//.test(rest) && b.force === true) return ["force_push"];
  if ((method === "PUT" || method === "DELETE") && /^\/contents\//.test(rest)) return ["write_file"];
  if (edit && /^\/labels(\/[^/]+)?$/.test(rest)) return ["manage_labels"];
  if (edit && /^\/releases(\/.*)?$/.test(rest)) return ["manage_release"];
  if (edit && /^\/actions\/(runs|jobs|workflows|caches|artifacts)(\/.*)?$/.test(rest)) return ["manage_actions"];
  if (edit && /^\/(actions|environments\/[^/]+)\/(variables|secrets)(\/.*)?$/.test(rest)) return ["manage_variables"];
  if (method === "PATCH" && rest === "") return ["edit_repo"];
  if (method === "PUT" && /^\/topics$/.test(rest)) return ["edit_repo"];
  if (method === "POST" && /^\/forks$/.test(rest)) return ["create_repo"];
  if (edit && /^\/notifications(\/.*)?$/.test(rest)) return ["manage_notifications"];
  return [];
}

/** The same for writes on paths that are not under /repos/{owner}/{repo}. */
function accountWriteActions(method: string, path: string): Action[] {
  if (method === "POST" && (/^\/orgs\/[^/]+\/repos$/.test(path) || path === "/user/repos")) return ["create_repo"];
  if (/^\/orgs\/[^/]+\/actions\/(variables|secrets)(\/.*)?$/.test(path) && method !== "GET") return ["manage_variables"];
  if (/^\/gists(\/.*)?$/.test(path)) return ["manage_gists"];
  if (/^\/notifications(\/.*)?$/.test(path)) return ["manage_notifications"];
  return [];
}

/** Classifies a generic REST call: which owner it touches and which actions it needs. */
export function classifyRest(methodIn: string, pathIn: string, body?: unknown, query = ""): Classified {
  const method = methodIn.toUpperCase();
  const path = canonicalRestPath(pathIn); // throws PathError: the path that is classified is the path that is sent
  const read = method === "GET" || method === "HEAD";
  const base = (specific: Action[]): Action[] => (read ? ["generic_api_read"] : [...specific, "generic_api_write"]);

  const repoMatch = REPO_PATH.exec(path);
  if (repoMatch) {
    const owner = repoMatch[1]!;
    const repo = `${owner}/${repoMatch[2]}`;
    return { repo, owners: [owner.toLowerCase()], actions: base(read ? [] : restWriteActions(method, repoMatch[3] ?? "", body)) };
  }
  const scoped = /^\/(?:orgs|users)\/([^/]+)/.exec(path);
  if (scoped) return { repo: "", owners: [scoped[1]!.toLowerCase()], actions: base(read ? [] : accountWriteActions(method, path)) };
  if (path.startsWith("/search/")) {
    const { owners, scoped: hasScope } = searchOwners(query);
    return {
      repo: "",
      owners,
      actions: read ? ["generic_api_read"] : ["generic_api_write"],
      ...(hasScope ? {} : { unscoped: "a search needs a repo:, org: or user: qualifier so it can be checked against the allowed owners" }),
    };
  }
  if (read && (path === "/rate_limit" || path === "/user")) return { repo: "", owners: [], actions: ["generic_api_read"] };
  return { repo: "", owners: [], actions: base(read ? [] : accountWriteActions(method, path)), unscoped: `the path ${path} is not scoped to an owner (use /repos/{owner}/{repo}/..., /orgs/{org}/... or /users/{user}/...)` };
}

const MUTATION_ACTIONS: Record<string, Action> = {
  mergePullRequest: "merge",
  enablePullRequestAutoMerge: "merge",
  addComment: "comment",
  addPullRequestReviewComment: "comment",
  addPullRequestReviewThreadReply: "comment",
  addPullRequestReview: "review",
  submitPullRequestReview: "review",
  createIssue: "create_issue",
  createPullRequest: "create_pr",
  updatePullRequest: "update_pr",
  closePullRequest: "update_pr",
  reopenPullRequest: "update_pr",
  updateIssue: "update_pr",
  closeIssue: "update_pr",
  reopenIssue: "update_pr",
  deleteRef: "delete_branch",
  createRef: "create_branch",
  markPullRequestReadyForReview: "update_pr",
  convertPullRequestToDraft: "update_pr",
  disablePullRequestAutoMerge: "merge",
  resolveReviewThread: "review",
  unresolveReviewThread: "review",
  addLabelsToLabelable: "update_pr",
  removeLabelsFromLabelable: "update_pr",
  addProjectV2ItemById: "manage_project",
  updateProjectV2ItemFieldValue: "manage_project",
  archiveProjectV2Item: "manage_project",
  unarchiveProjectV2Item: "manage_project",
  deleteProjectV2Item: "manage_project",
  clearProjectV2ItemFieldValue: "manage_project",
};

/** Removes comments and string literals so that braces and keywords inside them do not count. */
function stripNoise(query: string): string {
  return query.replace(/#[^\n]*/g, "").replace(/"""[\s\S]*?"""/g, '""').replace(/"(?:\\.|[^"\\])*"/g, '""');
}

export interface GraphqlInfo {
  operation: "query" | "mutation" | "subscription";
  /** Root fields of every mutation operation. */
  mutationFields: string[];
  /** `owner: "x"` literals found in the document, lower-cased. */
  owners: string[];
  usesNodeId: boolean;
  force: boolean;
}

/** A small tokenizer-based parser: enough to tell queries from mutations and to see the root fields. Not a validator. */
export function parseGraphql(query: string, variables?: Record<string, unknown>): GraphqlInfo {
  const literalOwners = [...query.matchAll(/\bowner\s*:\s*"([^"]+)"/g)].map((m) => m[1]!.toLowerCase());
  const variableOwner = typeof variables?.owner === "string" ? [variables.owner.toLowerCase()] : [];
  const doc = stripNoise(query);
  const tokens = doc.match(/\.\.\.|[A-Za-z_]\w*|[{}()\[\]:!@$=,]/g) ?? [];
  let operation: GraphqlInfo["operation"] = "query";
  const mutationFields: string[] = [];
  let depth = 0;
  let parens = 0;
  let current = "query";
  let expectField = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "(") parens++;
    else if (token === ")") parens--;
    else if (token === "{" && parens === 0) {
      depth++;
      expectField = depth === 1;
    } else if (token === "}" && parens === 0) {
      depth--;
      expectField = depth === 1;
    } else if (parens === 0 && depth === 0) {
      if (token === "query" || token === "mutation" || token === "subscription" || token === "fragment") {
        current = token;
        if (token === "mutation") operation = "mutation";
        else if (token === "subscription" && operation !== "mutation") operation = "subscription";
      }
    } else if (parens === 0 && depth === 1 && expectField && /^[A-Za-z_]/.test(token) && current === "mutation") {
      // `alias: field(...)` or `field(...)`.
      const name = tokens[i + 1] === ":" ? tokens[i + 2] : token;
      if (name) mutationFields.push(name);
      expectField = false;
    }
  }
  return {
    operation,
    mutationFields: [...new Set(mutationFields)],
    owners: [...new Set([...literalOwners, ...variableOwner])],
    usesNodeId: /\bnodes?\s*\(/.test(doc),
    force: /\bforce\s*:\s*true\b/.test(doc),
  };
}

export function classifyGraphql(query: string, repo: string, variables?: Record<string, unknown>): Classified & { info: GraphqlInfo } {
  const info = parseGraphql(query, variables);
  const owners = [...new Set([...(repo ? [repo.split("/")[0]!.toLowerCase()] : []), ...info.owners])];
  const actions: Action[] = [];
  if (info.operation === "query") actions.push("generic_api_read");
  else {
    actions.push("generic_api_write");
    for (const field of info.mutationFields) {
      const specific = MUTATION_ACTIONS[field];
      if (specific) actions.push(specific);
      if (field === "updateRef" && info.force) actions.push("force_push");
    }
  }
  const out: Classified & { info: GraphqlInfo } = { repo, owners, actions: [...new Set(actions)], info };
  if (!repo) out.unscoped = "a GraphQL call needs the repo (owner/name) it is about, to check it against the policy and the allowed owners";
  else if (info.usesNodeId) out.unscoped = "queries by node id cannot be scoped to an owner; use repository(owner:, name:) instead";
  return out;
}
