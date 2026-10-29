import { decide, personalLayer } from "@okayed/engine";
import { describe, expect, it } from "vitest";
import { GITHUB_SCOPES, SITE_SCOPES, SLACK_SCOPES, actionScopes, rulesForScopes, scopeCeiling, scopesFor } from "../src/index.ts";

const NOW = 1_761_735_600;
const DEFS = [...GITHUB_SCOPES, ...SITE_SCOPES, ...SLACK_SCOPES];

describe("OAuth scopes", () => {
  it("become rules, values and all", () => {
    expect(rulesForScopes("repo deploy:staging openid", DEFS)).toEqual([
      { id: "scope:repo", effect: "allow", act: "github.*", res: "github:**", note: "the token's repo scope" },
      { id: "scope:deploy:staging", effect: "allow", act: "site.deploy", res: "site:*/staging", note: "the token's deploy:staging scope" },
    ]);
  });

  it("never let a scope's value widen what it names", () => {
    expect(rulesForScopes(["deploy:*", "deploy:a/b", "deploy:**"], DEFS)).toEqual([]);
  });

  it("bound one agent to what its token carries, and leave other agents alone", () => {
    const policy = { layers: [scopeCeiling("deploy:staging", DEFS, { agent: "agent:ci" }), personalLayer([{ id: "all", effect: "allow" as const, act: "*" }])] };
    expect(decide(policy, "site.deploy", "site:acme.dev/staging", NOW, { agent: "agent:ci" }).verdict).toBe("allow");
    expect(decide(policy, "site.deploy", "site:acme.dev/production", NOW, { agent: "agent:ci" }).reason).toBe("Refused by the token's scopes: no scope the token carries covers it.");
    expect(decide(policy, "github.read", "github:acme/web", NOW, { agent: "agent:ci" }).verdict).toBe("deny");
    expect(decide(policy, "site.deploy", "site:acme.dev/production", NOW, { agent: "agent:assistant" }).verdict).toBe("allow");
  });

  it("say which scopes a grant's credential needs, narrowest first", () => {
    expect(scopesFor("site.deploy", "site:acme.dev/staging", DEFS)).toEqual(["deploy:staging"]);
    expect(scopesFor("github.pr.merge", "github:acme/web/pull/7", DEFS)).toEqual(["repo"]);
    expect(scopesFor("slack.message.post", "slack:acme/releases", DEFS)).toEqual([]);
    expect(scopesFor("site.deploy", "site:acme.dev/staging", [...actionScopes(), ...SITE_SCOPES])).toEqual(["deploy:staging", "site.deploy", "site.*"]);
  });
});
