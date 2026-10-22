import { describe, expect, it } from "vitest";
import { extractAnchors, policyClauses } from "../src/index.ts";
import { targets } from "./fixtures.ts";

describe("extractAnchors", () => {
  it("reads a merge approval", () => {
    const a = extractAnchors("I approve merging #182", targets);
    expect(a.acts).toEqual(["github.pr.merge"]);
    expect(a.prNumbers).toEqual([182]);
    expect(a.approves).toBe(true);
    expect(a.uses).toBeUndefined();
  });

  it("reads a deploy with site and environment", () => {
    const a = extractAnchors("go ahead and deploy openmeadow to staging", targets);
    expect(a.acts).toEqual(["site.deploy"]);
    expect(a.sites).toEqual(["openmeadow.org"]);
    expect(a.envs).toEqual(["staging"]);
  });

  it("treats 'go live' as a verb, not an environment", () => {
    const a = extractAnchors("let the website go live", targets);
    expect(a.acts).toEqual(["site.deploy"]);
    expect(a.envs).toEqual([]);
    expect(a.genericSite).toBe(true);
  });

  it("sees negation", () => {
    const a = extractAnchors("merge #182 but don't deploy, and not to production", targets);
    expect(a.acts).toEqual(["github.pr.merge"]);
    expect(a.negatedActs).toEqual(["site.deploy"]);
    expect(a.negatedEnvs).toEqual(["production"]);
  });

  it("separates 'once' as a count from 'once' as a condition", () => {
    expect(extractAnchors("merge it once", targets).uses).toBe(1);
    const c = extractAnchors("merge #182 once CI passes", targets);
    expect(c.uses).toBeUndefined();
    expect(c.conditions).toEqual([{ c: "checks.pass" }]);
    expect(extractAnchors("deploy three times", targets).uses).toBe(3);
    expect(extractAnchors("deploy twice", targets).uses).toBe(2);
  });

  it("reads durations and refuses to honor forever", () => {
    expect(extractAnchors("for 10 minutes", targets).ttl).toBe(600);
    expect(extractAnchors("for an hour", targets).ttl).toBe(3600);
    expect(extractAnchors("for the next 2 hours", targets).ttl).toBe(7200);
    expect(extractAnchors("for half an hour", targets).ttl).toBe(1800);
    expect(extractAnchors("forever", targets).unbounded).toBe(true);
  });

  it("finds repos by full name or known short name, not prose like and/or", () => {
    expect(extractAnchors("merge #7 in matrix", targets).repos).toEqual(["adrianmross/matrix"]);
    expect(extractAnchors("merge adrianmross/okayed#182", targets).repos).toEqual(["adrianmross/okayed"]);
    expect(extractAnchors("read and/or write", targets).repos).toEqual([]);
  });

  it("finds commit prefixes", () => {
    expect(extractAnchors("merge #182 at 3f9a1c2", targets).shas).toEqual(["3f9a1c2"]);
  });
});

describe("policyClauses", () => {
  it("splits a two-part policy", () => {
    const c = policyClauses("auto-approve read-only GitHub for 1 hour; ask me before anything that spends money", targets);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ effect: "allow", acts: ["github.read"], ttl: 3600 });
    expect(c[1]).toMatchObject({ effect: "ask", acts: ["spend.money"] });
  });

  it("splits on 'but'", () => {
    const c = policyClauses("allow reads on okayed but never merge", targets);
    expect(c.map((x) => x.effect)).toEqual(["allow", "deny"]);
    expect(c[0]!.repos).toEqual(["adrianmross/okayed"]);
  });

  it("reads \"don't ask\" as allow", () => {
    expect(policyClauses("don't ask me about reading github", targets)[0]!.effect).toBe("allow");
  });
});
