/**
 * The one place that decides what a GitHub REST path and an owner/repo name may look like.
 *
 * The proxy classifies a call (owner, actions), checks the policy, keys the cache and sends the request. All four must
 * see the same string, and that string must reach GitHub unchanged: an HTTP client resolves dot segments and decodes
 * escapes, so a path like `/repos/allowed/x/../../victim/y` would be checked as `allowed` and fetched as `victim`.
 * So nothing is normalized here: an ambiguous path is rejected, and an accepted one is used verbatim.
 */

/** Thrown for a name or path that is refused. The message addresses the agent. */
export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export const isOwnerName = (value: string): boolean => OWNER.test(value);
export const isRepoName = (value: string): boolean => REPO.test(value) && value !== "." && value !== "..";

const refuse = (what: string, why: string): never => {
  throw new PathError(`Denied: ${what} is refused (${why}). Rule: owner, repository and REST path names must be plain and unambiguous (no dot segments, encoded slashes or dots, backslashes, ? or #, control characters or non-ASCII in the path). Do not retry this call as is: pass a plain value.`);
};

const show = (value: string): string => JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}...` : value);

/** Validates an owner (user or organization login). Returns it unchanged. */
export function parseOwner(value: string, label = "the owner"): string {
  if (!OWNER.test(value)) refuse(`${label} ${show(value)}`, "an owner is 1 to 39 letters, digits or hyphens and does not start with a hyphen");
  return value;
}

/** Validates `owner/name`. Returns it unchanged, with its two parts. */
export function parseRepo(value: string, label = "the repository"): { full: string; owner: string; name: string } {
  const parts = value.split("/");
  const [owner = "", name = ""] = parts;
  if (parts.length !== 2 || !OWNER.test(owner) || !isRepoName(name)) refuse(`${label} ${show(value)}`, "it must be exactly owner/name, with an owner of letters, digits and hyphens and a name of letters, digits, dots, underscores and hyphens");
  return { full: value, owner, name };
}

/**
 * Validates a REST path (without its query string) and returns it unchanged.
 *
 * - It starts with one `/`, has no empty segment (`//`, trailing `/`), and holds only printable ASCII.
 * - No `?`, `#` or `\`: the query goes in the separate query parameter.
 * - A segment is never `.` or `..`, raw or percent-encoded, and never decodes to something containing `/`, `\`, a
 *   control character or a further escape of those. Percent-encoding is allowed only in segments after the
 *   repository (or after the first segment of /orgs and /users), for example a file name or a label; `%2F` is refused
 *   everywhere because the tools send slashes raw (`feature/x`), and `%25` cannot hide an escape.
 * - The owner and repository segments of /repos/{owner}/{repo}, and the login of /orgs/{org} and /users/{user}, are
 *   raw valid names with no escape at all.
 */
export function canonicalRestPath(path: string): string {
  if (typeof path !== "string") return refuse("the path", "it is not text");
  if (path === "/") return path;
  // eslint-disable-next-line no-control-regex
  if (/[^\x21-\x7e]/.test(path)) refuse(`the path ${show(path)}`, "it holds spaces, control characters or non-ASCII characters; percent-encode them");
  if (!path.startsWith("/") || path.startsWith("//")) refuse(`the path ${show(path)}`, "it must start with a single / and be a path, not a URL");
  if (/[?#\\]/.test(path)) refuse(`the path ${show(path)}`, "it contains ?, # or a backslash; pass the query string as params");
  const segments = path.slice(1).split("/");
  for (const segment of segments) {
    if (segment === "") refuse(`the path ${show(path)}`, "it has an empty segment (// or a trailing /)");
    if (/%(?![0-9A-Fa-f]{2})/.test(segment)) refuse(`the path ${show(path)}`, "it has a malformed percent escape");
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return refuse(`the path ${show(path)}`, "it has a malformed percent escape");
    }
    // eslint-disable-next-line no-control-regex
    if (segment === "." || segment === ".." || decoded === "." || decoded === ".." || /[/\\\x00-\x1f\x7f]/.test(decoded) || /%(?:2e|2f|5c)/i.test(decoded)) {
      refuse(`the path ${show(path)}`, "it has a dot segment, an encoded slash, backslash or dot, or a control character");
    }
    if (/%2f/i.test(segment)) refuse(`the path ${show(path)}`, "it has an encoded slash");
  }
  const [first, second, third] = segments;
  const named = (segment: string | undefined, valid: (s: string) => boolean, what: string): void => {
    if (segment === undefined) return;
    if (!valid(segment)) refuse(`the ${what} in ${show(path)}`, "it is not a plain name");
  };
  if (first === "repos") {
    named(second, isOwnerName, "owner");
    named(third, isRepoName, "repository name");
  } else if (first === "orgs" || first === "users") named(second, isOwnerName, "login");
  return path;
}
