import { describe, expect, it } from "vitest";
import { policySchema } from "../shared/policy";
import { decide } from "./policy";

const policy = (p: object = {}) => policySchema.parse(p);

describe("decide", () => {
  it("allows comments, PR creation, labels and review requests by default", () => {
    for (const op of ["comment", "pr.create", "label", "review.request"] as const) {
      expect(decide(policy(), "acme/app", [op]).allowed).toBe(true);
    }
  });

  it("refuses merges, admin and unclassified writes by default", () => {
    for (const op of ["pr.merge", "admin", "other", "pr.close", "review.submit", "branch.delete"] as const) {
      const d = decide(policy(), "acme/app", [op]);
      expect(d.allowed).toBe(false);
      expect(d.reason).toContain("Nothing was sent to GitHub");
    }
  });

  it("requires every operation of a call to be allowed", () => {
    const d = decide(policy(), "acme/app", ["comment", "pr.merge"]);
    expect(d).toMatchObject({ allowed: false, refused: ["pr.merge"] });
  });

  it("lets a repo rule allow merges for one repository only", () => {
    const p = policy({ repos: [{ repo: "acme/app", allow: ["pr.merge"] }] });
    expect(decide(p, "acme/app", ["pr.merge"]).allowed).toBe(true);
    expect(decide(p, "ACME/App", ["pr.merge"]).allowed).toBe(true);
    expect(decide(p, "acme/other", ["pr.merge"]).allowed).toBe(false);
  });

  it("supports owner wildcards and a deny that beats a broader allow", () => {
    const p = policy({ repos: [{ repo: "acme/*", allow: ["pr.merge"] }, { repo: "acme/tf-aws", deny: ["pr.merge"] }] });
    expect(decide(p, "acme/web", ["pr.merge"]).allowed).toBe(true);
    const d = decide(p, "acme/tf-aws", ["pr.merge"]);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("acme/tf-aws");
  });

  it("applies a deny even when a more specific rule allows", () => {
    const p = policy({ repos: [{ repo: "acme/*", deny: ["pr.merge"] }, { repo: "acme/app", allow: ["pr.merge"] }] });
    expect(decide(p, "acme/app", ["pr.merge"]).allowed).toBe(false);
  });

  it("can deny a default-allowed operation", () => {
    const p = policy({ repos: [{ repo: "*", deny: ["comment"] }] });
    expect(decide(p, "acme/app", ["comment"]).allowed).toBe(false);
  });

  it("honours the global allow and deny lists", () => {
    expect(decide(policy({ allow: ["comment"] }), "a/b", ["label"]).allowed).toBe(false);
    expect(decide(policy({ deny: ["label"] }), "a/b", ["label"]).allowed).toBe(false);
  });

  it("strict mode (repository unknown): every deny applies, only global rules allow", () => {
    const p = policy({ repos: [{ repo: "acme/tf-aws", deny: ["pr.merge"] }, { repo: "acme/app", allow: ["pr.merge"] }] });
    expect(decide(p, null, ["pr.merge"], true).allowed).toBe(false);
    const global = policy({ repos: [{ repo: "*", allow: ["pr.merge"] }] });
    expect(decide(global, null, ["pr.merge"], true).allowed).toBe(true);
    const globalButDenied = policy({ repos: [{ repo: "*", allow: ["pr.merge"] }, { repo: "acme/tf-aws", deny: ["pr.merge"] }] });
    expect(decide(globalButDenied, null, ["pr.merge"], true).allowed).toBe(false);
    expect(decide(policy(), null, ["comment"], true).allowed).toBe(true);
  });

  it("validates repo patterns", () => {
    expect(() => policy({ repos: [{ repo: "nope" }] })).toThrow();
    expect(() => policy({ repos: [{ repo: "a/b", allow: ["destroy"] }] })).toThrow();
    expect(policy({ repos: [{ repo: "*" }, { repo: "a/*" }, { repo: "a/b" }] }).repos).toHaveLength(3);
  });
});
