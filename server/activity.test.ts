import { describe, expect, it } from "vitest";
import { CallLog, humanize, recentActivity, type Call } from "./activity";
import { dynamicGithub, PR } from "./testing";

describe("humanize", () => {
  it.each([
    ["GET", "/repos/acme/app/pulls/7", "Read pull request acme/app#7"],
    ["GET", "/repos/acme/app/pulls/7/reviews?per_page=100", "Read the reviews of acme/app#7"],
    ["GET", "/repos/acme/app/commits/abc/check-runs?per_page=100", "Read the checks of a commit in acme/app"],
    ["GET", "/repos/acme/app/pulls?state=open", "Listed pull requests of acme/app"],
    ["POST", "/graphql", "Ran a GraphQL request"],
    ["POST", "/repos/acme/app/issues/7/comments", "Commented on acme/app#7"],
    ["PUT", "/repos/acme/app/pulls/7/merge", "Merged acme/app#7"],
    ["GET", "/user", "GET /user"],
  ])("%s %s", (m, p, text) => expect(humanize(m, p)).toBe(text));
});

const call = (over: Partial<Call>): Call => ({ at: 1000, method: "GET", path: "/repos/acme/app/pulls/7", status: 200, cached: false, priority: "interactive", ...over });

describe("recentActivity", () => {
  it("drops background polling and budget checks, flags cache hits and failures", () => {
    const out = recentActivity(
      [call({ at: 1 }), call({ at: 2, priority: "background" }), call({ at: 3, path: "/rate_limit" }), call({ at: 4, cached: true }), call({ at: 5, status: 404 })],
      [],
    );
    expect(out.map((e) => e.text)).toEqual(["Read pull request acme/app#7 (GitHub answered 404)", "Read pull request acme/app#7 (from cache)", "Read pull request acme/app#7"]);
    expect(out[0].outcome).toBe("failed");
  });

  it("merges refused writes by time, newest first, and limits to 10", () => {
    const calls = Array.from({ length: 12 }, (_, i) => call({ at: Date.parse("2026-01-01T00:00:00Z") + i * 1000 }));
    const refused = { at: "2026-01-01T00:00:05.500Z", agentId: null, repo: "acme/app", ops: ["pr.merge" as const], decision: "refused" as const, summary: "merge acme/app#7", detail: "Refused by policy", status: null };
    const out = recentActivity(calls, [refused, { ...refused, decision: "allowed" }]);
    expect(out).toHaveLength(10);
    expect(out.find((e) => e.outcome === "refused")).toMatchObject({ text: "Refused: merge acme/app#7", detail: "Refused by policy" });
    expect(out.map((e) => e.at)).toEqual([...out.map((e) => e.at)].sort().reverse());
  });
});

describe("client call log", () => {
  it("records every request, successful or not, without the query string leaking tokens", async () => {
    const log = new CallLog();
    const { client } = dynamicGithub((p) => (p === "/repos/acme/app/pulls/7" ? PR : undefined));
    const logged = new (client.constructor as new (o: object) => typeof client)({ tokens: (client as any).tokens, fetch: (client as any).fetchImpl, calls: log });
    await logged.rest({ owner: "acme", path: "/repos/acme/app/pulls/7", priority: "interactive" });
    await logged.rest({ owner: "acme", path: "/repos/acme/app/pulls/99" }).catch(() => {});
    expect(log.all().map((c) => [c.path, c.status])).toEqual([["/repos/acme/app/pulls/7", 200], ["/repos/acme/app/pulls/99", 404]]);
    expect(JSON.stringify(log.all())).not.toContain("tok_");
  });
});
