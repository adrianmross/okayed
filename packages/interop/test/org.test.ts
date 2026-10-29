import { decide, personalLayer, type Policy } from "@okayed/engine";
import { describe, expect, it } from "vitest";
import { ceilingFor, checkOrgPolicy, readOrgPolicy, type OrgPolicy } from "../src/index.ts";

const NOW = 1_761_735_600;
const ACME: OrgPolicy = {
  name: "Acme",
  default: "deny",
  grants: [
    { to: "*", effect: "allow", act: "github.read" },
    { to: "release-managers", effect: "allow", act: "github.pr.merge", res: "github:acme/**" },
    { to: "role:deployer", effect: "allow", act: "site.deploy", res: "site:*/staging" },
    { to: "role:deployer", effect: "ask", act: "site.deploy", res: "site:*/production", note: "production always needs a person" },
  ],
};
const PR = "github:acme/web/pull/7@3f9a1c2e4b5d6f708192a3b4c5d6e7f801234567";

describe("an organization's policy", () => {
  const policyFor = (groups: string[], roles: string[] = []): Policy => ({ layers: [ceilingFor({ groups, roles, active: true }, ACME), personalLayer()] });

  it("gives each person only their groups' part, above their own rules", () => {
    expect(decide(policyFor([]), "github.read", "github:acme/web", NOW).verdict).toBe("allow");
    expect(decide(policyFor([]), "github.pr.merge", PR, NOW).verdict).toBe("deny");
    expect(decide(policyFor(["release-managers"]), "github.pr.merge", PR, NOW).verdict).toBe("allow");
    expect(decide(policyFor(["release-managers"]), "github.pr.merge", PR.replace("acme/web", "other/web"), NOW).reason).toBe("Refused by Acme: nothing here covers github.pr.merge.");
  });

  it("grants to roles, and can insist on a person even where their rules would allow", () => {
    expect(decide(policyFor([], ["deployer"]), "site.deploy", "site:acme.dev/staging", NOW).verdict).toBe("allow");
    const prod = decide({ layers: [ceilingFor({ groups: [], roles: ["deployer"], active: true }, ACME), personalLayer([{ id: "all", effect: "allow", act: "*" }])] }, "site.deploy", "site:acme.dev/production", NOW);
    expect(prod).toMatchObject({ verdict: "ask", decidedBy: "Acme" });
  });

  it("blocks everything for someone no longer active", () => {
    const gone = { layers: [ceilingFor({ groups: ["release-managers"], roles: [], active: false }, ACME), personalLayer()] };
    expect(decide(gone, "github.read", "github:acme/web", NOW).reason).toBe("Refused by Acme: you're no longer active at Acme.");
  });

  it("is checked before it's used", () => {
    expect(checkOrgPolicy({ name: "", default: "allow", grants: [{ to: "", effect: "allow", act: "x" }, { to: "a", effect: "maybe", act: "fax.send" }] })).toEqual([
      "needs a name, e.g. Acme",
      "default must be deny or abstain",
      "grant 1: needs to (a group, role:<name>, or *)",
      'grant 2: effect must be allow, ask or deny',
      'grant 2: "fax.send" matches no known action',
    ]);
    expect(readOrgPolicy(JSON.stringify(ACME))).toEqual(ACME);
    expect(readOrgPolicy("")).toBeNull();
    expect(() => readOrgPolicy("{")).toThrow(/valid JSON/);
  });
});
