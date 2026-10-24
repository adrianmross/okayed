import { describe, expect, it } from "vitest";
import { decide, decideAll, defaultPolicy, lint, personalLayer, type Layer, type Policy, type Rule } from "../src/index.ts";
import { NOW, SHA } from "./fixtures.ts";

const PR = `github:adrianmross/okayed/pull/182@${SHA}`;
const ASSISTANT = { agent: "agent:assistant" };
const you = (...rules: Rule[]): Policy => ({ layers: [personalLayer(rules)] });

describe("the default posture", () => {
  const p = defaultPolicy();
  it("lets reads and checked merges go ahead, and asks for production and money", () => {
    expect(decide(p, "github.read", "github:adrianmross/okayed", NOW, ASSISTANT).verdict).toBe("allow");
    expect(decide(p, "github.pr.merge", PR, NOW, ASSISTANT).verdict).toBe("allow");
    expect(decide(p, "site.deploy", "site:openmeadow.org/staging", NOW, ASSISTANT).verdict).toBe("allow");
    expect(decide(p, "site.deploy", "site:openmeadow.org/production", NOW, ASSISTANT).verdict).toBe("ask");
    expect(decide(p, "spend.money", "money:card-1/USD/20", NOW, ASSISTANT).verdict).toBe("ask");
  });

  it("requires passing checks on merges it allows", () => {
    expect(decide(p, "github.pr.merge", PR, NOW, ASSISTANT).when).toEqual([{ c: "checks.pass" }]);
  });

  it("charges a merge against the merge budget at its risk cost", () => {
    expect(decide(p, "github.pr.merge", PR, NOW, ASSISTANT).charges).toEqual([{ layer: "you", rule: "posture:merge", cost: 8 }]);
  });

  it("is ordinary rules the person can change", () => {
    const strict = you(...defaultPolicy().layers[0]!.rules.filter((r) => r.id !== "posture:merge"));
    expect(decide(strict, "github.pr.merge", PR, NOW, ASSISTANT).verdict).toBe("ask");
  });
});

describe("standing policies", () => {
  const mergeAnything: Rule = { id: "m", effect: "allow", act: "github.pr.merge", res: "github:adrianmross/okayed/**", agent: "agent:assistant", until: NOW + 14 * 86400, budget: { uses: 3 } };

  it("allow repeat actions within their scope", () => {
    expect(decide(you(mergeAnything), "github.pr.merge", PR, NOW, ASSISTANT).verdict).toBe("allow");
  });

  it("only for the agent they name", () => {
    expect(decide(you(mergeAnything), "github.pr.merge", PR, NOW, { agent: "agent:buzz" }).verdict).toBe("ask");
    expect(decide(you(mergeAnything), "github.pr.merge", PR, NOW, {}).verdict).toBe("ask");
  });

  it("only within their horizon", () => {
    expect(decide(you(mergeAnything), "github.pr.merge", PR, NOW + 14 * 86400, ASSISTANT).verdict).toBe("ask");
    expect(decide(you({ ...mergeAnything, from: NOW + 60 }), "github.pr.merge", PR, NOW, ASSISTANT).verdict).toBe("ask");
  });

  it("ask once a use budget is spent, and say so", () => {
    const d = decide(you(mergeAnything), "github.pr.merge", PR, NOW, { ...ASSISTANT, usage: { m: { uses: 3, risk: 24 } } });
    expect(d.verdict).toBe("ask");
    expect(d.layers[0]).toMatchObject({ spent: true, left: { uses: 0 } });
    expect(d.reason).toMatch(/budget is spent/);
  });

  it("ask once a risk budget can't cover the next use", () => {
    const r: Rule = { id: "d", effect: "allow", act: "site.deploy", budget: { risk: 10 } };
    expect(decide(you(r), "site.deploy", "site:x.org/staging", NOW, { usage: { d: { uses: 2, risk: 6 } } }).verdict).toBe("allow");
    // Production costs more (high risk = 8): the same budget can't cover it.
    expect(decide(you(r), "site.deploy", "site:x.org/production", NOW, { usage: { d: { uses: 2, risk: 6 } } }).verdict).toBe("ask");
  });

  it("one grant over several targets draws once", () => {
    const r: Rule = { id: "rd", effect: "allow", act: "github.read", budget: { uses: 5 } };
    expect(decideAll(you(r), "github.read", ["github:a/b", "github:a/c"], NOW).charges).toEqual([{ layer: "you", rule: "rd", cost: 1 }]);
  });

  it("caps each grant they issue", () => {
    const r: Rule = { id: "r", effect: "allow", act: "github.read", maxTtl: 600, maxUses: 3 };
    expect(decide(you(r), "github.read", "github:a/b", NOW).caps).toEqual({ ttl: 600, uses: 3 });
  });
});

describe("layers", () => {
  const org: Layer = { name: "org", default: "abstain", rules: [{ id: "o", effect: "ask", act: "github.pr.merge", note: "the org asks for merges" }] };

  it("a lower layer can't widen a higher one; the reason names the higher one", () => {
    const p: Policy = { layers: [org, personalLayer()] };
    const d = decide(p, "github.pr.merge", PR, NOW, ASSISTANT);
    expect(d.verdict).toBe("ask");
    expect(d.decidedBy).toBe("org");
    expect(d.reason).toMatch(/org asks for merges/);
  });

  it("charges every layer that allowed by a budgeted rule", () => {
    const orgBudget: Layer = { name: "org", default: "abstain", rules: [{ id: "ob", effect: "allow", act: "github.*", budget: { risk: 100 } }] };
    const d = decide({ layers: [orgBudget, personalLayer()] }, "github.pr.merge", PR, NOW, ASSISTANT);
    expect(d.charges.map((c) => c.rule)).toEqual(["ob", "posture:merge"]);
  });

  it("deny anywhere wins", () => {
    const p: Policy = { layers: [personalLayer([{ id: "x", effect: "deny", act: "*", res: "github:adrianmross/matrix/**" }])] };
    expect(decide(p, "github.read", "github:adrianmross/matrix", NOW).verdict).toBe("deny");
  });

  it("most specific rule wins in a layer; ties go to the strictest", () => {
    const p = you(
      { id: "a", effect: "allow", act: "github.read" },
      { id: "b", effect: "deny", act: "github.read", res: "github:adrianmross/matrix" },
      { id: "c", effect: "ask", act: "github.read" },
    );
    expect(decide(p, "github.read", "github:adrianmross/matrix", NOW).layers[0]!.rule!.id).toBe("b");
    expect(decide(p, "github.read", "github:adrianmross/okayed", NOW).layers[0]!.rule!.id).toBe("c");
  });

  it("all-abstain denies", () => {
    expect(decide({ layers: [{ name: "x", default: "abstain", rules: [] }] }, "github.read", "github:a/b", NOW).verdict).toBe("deny");
  });
});

describe("lint", () => {
  it("warns about standing authority over risky actions with no end and no budget", () => {
    const w = lint(you({ id: "m", effect: "allow", act: "github.pr.merge" }), NOW);
    expect(w[0]!.message).toMatch(/no end date and no budget/);
    expect(lint(you({ id: "m", effect: "allow", act: "github.pr.merge", budget: { uses: 5 } }), NOW)).toEqual([]);
  });

  it("flags a rule a layer above makes ineffective", () => {
    const org: Layer = { name: "org", default: "abstain", rules: [{ id: "o", effect: "ask", act: "github.pr.merge" }] };
    const w = lint({ layers: [org, personalLayer([{ id: "w", effect: "allow", act: "github.pr.merge", budget: { uses: 1 } }])] }, NOW);
    expect(w.map((x) => x.message).join()).toMatch(/can only narrow/);
  });

  it("flags unknown actions and ended rules; the default posture is clean", () => {
    expect(lint(you({ id: "u", effect: "ask", act: "aws.*" }, { id: "e", effect: "allow", act: "github.read", until: NOW - 5 }), NOW).map((w) => w.rule)).toEqual(["u", "e"]);
    expect(lint(defaultPolicy(), NOW)).toEqual([]);
  });
});
