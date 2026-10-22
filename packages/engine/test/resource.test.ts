import { describe, expect, it } from "vitest";
import { canonRes, fitsAction, isPattern, matchAct, matchRes, parseRes } from "../src/index.ts";
import { SHA } from "./fixtures.ts";

describe("resources", () => {
  it("parses and canonicalizes exact forms", () => {
    expect(parseRes("github:AdrianMRoss/Okayed")).toEqual({ kind: "github.repo", owner: "adrianmross", repo: "okayed" });
    expect(canonRes(`github:a/b/pull/12@${SHA.toUpperCase()}`)).toBe(`github:a/b/pull/12@${SHA}`);
    expect(parseRes("site:openmeadow.org/production")).toEqual({ kind: "site", host: "openmeadow.org", env: "production" });
    expect(parseRes("money:card-1/USD/20")).toEqual({ kind: "money", account: "card-1", currency: "USD", max: 20 });
  });

  it("rejects patterns, junk and near-misses", () => {
    for (const bad of ["github:*/*", "github:a/b/pull/0", "github:a/b/pull/1@abc", "site:x", "github:a/b/../c", "", "github: a/b", "github:a/b/pull/12@" + SHA + "x"]) {
      expect(parseRes(bad), bad).toBeNull();
    }
    expect(isPattern("github:a/**")).toBe(true);
  });

  it("matches patterns by segment", () => {
    expect(matchRes("github:adrianmross/**", `github:adrianmross/okayed/pull/1@${SHA}`)).toBe(true);
    expect(matchRes("github:adrianmross/*", "github:adrianmross/okayed")).toBe(true);
    expect(matchRes("github:adrianmross/*", `github:adrianmross/okayed/pull/1@${SHA}`)).toBe(false);
    expect(matchRes("github:adrianmross/**", "github:adrianmrossx/okayed")).toBe(false);
    expect(matchRes("site:*/staging", "site:openmeadow.org/production")).toBe(false);
    expect(matchRes(undefined, "anything-at-all")).toBe(true);
  });

  it("matches action patterns", () => {
    expect(matchAct("github.*", "github.pr.merge")).toBe(true);
    expect(matchAct("github.read", "github.read")).toBe(true);
    expect(matchAct("github.read", "github.readwrite")).toBe(false);
    expect(matchAct("github.*", "githubx.read")).toBe(false);
  });

  it("requires merges to pin a commit", () => {
    expect(fitsAction("github.pr.merge", "github:a/b/pull/1")).toBe(false);
    expect(fitsAction("github.pr.merge", `github:a/b/pull/1@${SHA}`)).toBe(true);
    expect(fitsAction("site.deploy", "github:a/b")).toBe(false);
  });
});
