import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CATALOG,
  EXAMPLE_PACKS,
  canonRes,
  checkUse,
  decide,
  describeRule,
  doesNotAllowFor,
  fitsAction,
  labelRes,
  matchRes,
  narrowGrant,
  narrowPolicy,
  parseRes,
  patternLabel,
  personalLayer,
  registerPack,
  registeredPacks,
  resourceType,
  riskCost,
  riskOf,
  ruleFromRequest,
  sentenceFor,
  unregisterPack,
  type CapabilityPack,
  type Policy,
  type Request,
  type Targets,
} from "../src/index.ts";
import { NOW, policy, targets } from "./fixtures.ts";

const RELEASES = "slack:acme/releases";
const world: Targets = {
  ...targets,
  named: [
    { res: RELEASES, names: ["#releases"] },
    { res: "slack:acme/general", names: ["#general"] },
    { res: "email:ada@example.com", names: ["ada@example.com", "Ada"] },
  ],
};
const postReq: Request = { id: "r_post", aud: "agent:assistant", act: "slack.message.post", res: [RELEASES], why: "release notes for 1.4", at: NOW - 10, exp: NOW + 1800 };

beforeEach(() => {
  for (const p of Object.values(EXAMPLE_PACKS)) registerPack(p);
});
afterEach(() => {
  for (const p of Object.values(EXAMPLE_PACKS)) unregisterPack(p.id);
});

describe("capability packs", () => {
  it("registers a pack's actions next to the built-in ones, and removes them again", () => {
    expect(CATALOG["slack.message.post"]).toMatchObject({ act: "slack.message.post", pack: "slack", res: ["slack.channel"], risk: "medium", verb: "post to" });
    expect(registeredPacks().map((p) => p.id)).toEqual(["github", "sites", "money", "slack", "email", "cloudflare-dns", "aws-s3"]);
    unregisterPack("slack");
    expect(CATALOG["slack.message.post"]).toBeUndefined();
    expect(resourceType("slack.channel")).toBeUndefined();
    expect(parseRes(RELEASES)).toBeNull();
    expect(CATALOG["github.pr.merge"]).toBeDefined();
  });

  it("refuses a pack that collides or doesn't make sense, and registers nothing from it", () => {
    expect(() => registerPack(EXAMPLE_PACKS.slack)).toThrow(/pack slack is already registered/);
    const base: CapabilityPack = { id: "x", title: "X", resources: [{ kind: "x.thing", template: "x:{name}" }], actions: [{ act: "x.do", verb: "do", noun: "doing x", risk: "low", ttl: 60, maxTtl: 120, uses: 1, maxUses: 2, res: ["x.thing"] }] };
    const bad = (patch: (p: CapabilityPack) => void) => {
      const p = structuredClone(base);
      patch(p);
      return () => registerPack(p);
    };
    expect(bad((p) => (p.actions[0]!.act = "github.read"))).toThrow(/action github.read is already registered/);
    expect(bad((p) => (p.resources![0]!.template = "github:{name}"))).toThrow(/github: scheme is built in/);
    expect(bad((p) => (p.resources![0]!.template = "x/{name}"))).toThrow(/must start with a scheme/);
    expect(bad((p) => (p.resources![0]!.template = "x:fixed"))).toThrow(/has no \{fields\}/);
    expect(bad((p) => (p.resources![0]!.template = "x:{name}/*"))).toThrow(/no wildcards/);
    expect(bad((p) => (p.resources![0]!.label = "{nope}"))).toThrow(/label names \{nope\}/);
    expect(bad((p) => (p.actions[0]!.ttl = 600))).toThrow(/defaults can't exceed the maximums/);
    expect(bad((p) => (p.actions[0]!.res = ["x.other"]))).toThrow(/resource kind x.other isn't declared/);
    expect(bad((p) => (p.actions[0]!.risk = "spicy" as never))).toThrow(/risk must be/);
    expect(bad((p) => p.actions.push({ ...p.actions[0]! }))).toThrow(/action x.do appears twice/);
    // A failed registration leaves nothing behind.
    expect(resourceType("x.thing")).toBeUndefined();
    expect(CATALOG["x.do"]).toBeUndefined();
    registerPack(base);
    expect(fitsAction("x.do", "x:widget")).toBe(true);
    unregisterPack("x");
  });
});

describe("resources from templates", () => {
  it("parses, spells, labels and matches a registered type, exact forms only", () => {
    expect(parseRes("slack:Acme/Releases")).toEqual({ kind: "custom", type: "slack.channel", fields: { workspace: "acme", channel: "releases" } });
    expect(canonRes("slack:Acme/Releases")).toBe(RELEASES);
    expect(labelRes(RELEASES)).toBe("#releases in acme");
    expect(parseRes("slack:acme/*")).toBeNull();
    expect(parseRes("slack:acme")).toBeNull();
    expect(matchRes("slack:acme/*", RELEASES)).toBe(true);
    expect(matchRes("slack:acme/general", RELEASES)).toBe(false);
    expect(matchRes("slack:**", RELEASES)).toBe(true);
    expect(fitsAction("slack.message.post", RELEASES)).toBe(true);
    expect(fitsAction("github.pr.merge", RELEASES)).toBe(false);
    expect(fitsAction("slack.message.post", "github:adrianmross/okayed")).toBe(false);
  });

  it("uses field patterns, uppercase labels and case-sensitive types", () => {
    expect(labelRes("email:Ada@Example.com")).toBe("ada@example.com");
    expect(matchRes("email:*@example.com", "email:ada@example.com")).toBe(true);
    expect(matchRes("email:*@example.com", "email:ada@example.org")).toBe(false);
    expect(labelRes("dns:okayed.dev/cname/www")).toBe("CNAME www in okayed.dev");
    expect(parseRes("dns:okayed.dev/bogus/www")).toBeNull();
    // S3 keys keep their case, in the resource and in patterns.
    expect(canonRes("s3:reports/2026/Q3.pdf")).toBe("s3:reports/2026/Q3.pdf");
    expect(matchRes("s3:reports/**", "s3:reports/2026/Q3.pdf")).toBe(true);
    expect(matchRes("s3:reports/2026/q3.pdf", "s3:reports/2026/Q3.pdf")).toBe(false);
  });

  it("prices risk from the action, raised by the resource where the pack says so", () => {
    expect(riskCost("slack.message.post", [RELEASES])).toBe(3);
    expect(riskOf("cloudflare.dns.edit", ["dns:okayed.dev/a/www"])).toBe("high");
    expect(riskOf("cloudflare.dns.edit", ["dns:okayed.dev/a/@"])).toBe("critical");
    expect(riskOf("cloudflare.dns.edit", ["dns:okayed.dev/ns/sub"])).toBe("critical");
    expect(riskOf("aws.s3.put", ["s3:reports/a.csv"])).toBe("medium");
    expect(riskCost("aws.s3.put", ["s3:prod-data/a.csv"])).toBe(8);
  });
});

describe("decisions and grants for a registered action", () => {
  const rules: Policy = {
    layers: [personalLayer([{ id: "slack:releases", effect: "allow", act: "slack.message.post", res: RELEASES, maxTtl: 600, maxUses: 3 }])],
  };

  it("decides per resource and applies per-grant caps", () => {
    const d = decide(rules, "slack.message.post", RELEASES, NOW);
    expect(d.verdict).toBe("allow");
    expect(d.caps).toEqual({ ttl: 600, uses: 3 });
    expect(d.charges).toEqual([{ key: "slack:releases", cost: 3 }]);
    expect(decide(rules, "slack.message.post", "slack:acme/general", NOW).verdict).toBe("ask");
  });

  it("narrows an okay of a pending request to exactly that request, whatever the draft asks", () => {
    const hostile = { act: "slack.*", res: ["slack:acme/general", "slack:acme/*", RELEASES], ttl: 999_999, uses: 50, aud: "agent:mallory" };
    const r = narrowGrant({ utterance: "approve that", proposal: hostile, requests: [postReq], targets: world, policy, now: NOW });
    expect(r.kind).toBe("grant");
    if (r.kind !== "grant") return;
    expect(r.draft).toMatchObject({ act: "slack.message.post", res: [RELEASES], aud: "agent:assistant", uses: 1, exp: NOW + 1800, risk: "medium" });
    expect(r.beyond.map((b) => b.field).sort()).toEqual(["act", "aud", "res", "res", "ttl", "uses"]);
    expect(sentenceFor(r.draft)).toBe("Lets assistant post to #releases in acme, once, within the next 30 minutes.");
    expect(doesNotAllowFor(r.draft)).toContain("post to anything but #releases in acme");
  });

  it("binds to the request the words name, and an email domain is not a site", () => {
    const mail: Request = { id: "r_mail", aud: "agent:assistant", act: "email.send", res: ["email:ada@example.com"], why: "invoice", at: NOW, exp: NOW + 600 };
    const r = narrowGrant({ utterance: "yes, email ada@example.com", proposal: {}, requests: [postReq, mail], targets: world, policy, now: NOW });
    expect(r.kind === "grant" && r.draft.res).toEqual(["email:ada@example.com"]);
  });

  it("pre-approves from words only for a known target, and asks which otherwise", () => {
    const ok = narrowGrant({ utterance: "post to #releases", proposal: {}, requests: [], targets: world, policy, now: NOW });
    expect(ok.kind === "grant" && ok.draft.res).toEqual([RELEASES]);
    const which = narrowGrant({ utterance: "post the notes to slack", proposal: { res: ["slack:acme/random"] }, requests: [], targets: world, policy, now: NOW });
    expect(which).toMatchObject({ kind: "question", options: ["#releases", "#general"] });
  });

  it("checks a use against the exact resource", () => {
    const g = { v: 0, id: "g", aud: "agent:assistant", act: "slack.message.post", res: [RELEASES], when: [], nbf: NOW, exp: NOW + 60, uses: 1, risk: "medium" as const };
    expect(checkUse(g, { aud: "agent:assistant", act: "slack.message.post", res: "slack:ACME/releases", now: NOW }, { revoked: false, used: 0, issuedAt: NOW })).toEqual({ ok: true, left: 0 });
    expect(checkUse(g, { aud: "agent:assistant", act: "slack.message.post", res: "slack:acme/general", now: NOW }, { revoked: false, used: 0, issuedAt: NOW })).toMatchObject({ ok: false, code: "wrong_resource" });
  });
});

describe("rules for a registered action", () => {
  it("reads “always allow posting to #releases for a week” as one rule on that channel", () => {
    const r = narrowPolicy({ utterance: "always allow posting to #releases for a week", proposal: { rules: [{ effect: "allow", act: "slack.message.post", res: "slack:acme/*" }] }, policy, layer: "you", targets: world, now: NOW });
    expect(r.kind).toBe("policy");
    if (r.kind !== "policy") return;
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0]).toMatchObject({ effect: "allow", act: "slack.message.post", res: RELEASES, until: NOW + 7 * 86400 });
    expect(r.beyond).toEqual([{ field: "res", asked: "slack:acme/*", granted: RELEASES, why: `you said ${RELEASES}` }]);
    expect(describeRule(r.rules[0]!, NOW)).toBe("Allow posting to Slack in #releases in acme for 7 days");
    expect(patternLabel(RELEASES)).toBe("#releases in acme");
  });

  it("makes “Always allow…” from a request: exact by default, or the pack's standing scope", () => {
    expect(ruleFromRequest(postReq, "r1")).toMatchObject({ act: "slack.message.post", res: RELEASES, agent: "agent:assistant" });
    expect(ruleFromRequest({ act: "aws.s3.put", res: ["s3:reports/2026/Q3.pdf"] }, "r2").res).toBe("s3:reports/**");
  });
});
