import { describe, expect, it } from "vitest";
import { decide, narrowPolicy } from "../src/index.ts";
import { NOW, policy, SHA, targets } from "./fixtures.ts";

const PR = `github:adrianmross/okayed/pull/182@${SHA}`;
const DAY = 86400;

function run(utterance: string, rules: unknown[]) {
  const r = narrowPolicy({ utterance, proposal: { rules }, policy, layer: "you", targets, now: NOW });
  return r;
}
function rules(utterance: string, draft: unknown[]) {
  const r = run(utterance, draft);
  if (r.kind !== "policy") throw new Error(`expected policy, got question: ${r.question}`);
  return r;
}

describe("narrowPolicy: what the sentence says", () => {
  it("turns the example sentence into two standing policies", () => {
    const r = rules("auto-approve read-only GitHub for 1 hour; ask me before anything that spends money", [
      { effect: "allow", act: "github.read", ttl: 3600 },
      { effect: "ask", act: "spend.money" },
    ]);
    expect(r.rules.map((x) => [x.effect, x.act, x.until])).toEqual([
      ["allow", "github.read", NOW + 3600],
      ["ask", "spend.money", undefined],
    ]);
    expect(r.beyond).toEqual([]);
    expect(decide(r.policy, "github.read", "github:adrianmross/okayed", NOW).verdict).toBe("allow");
    expect(decide(r.policy, "github.read", "github:adrianmross/okayed", NOW + 3600).verdict).toBe("ask");
  });

  it("lets an agent merge anything in one repo, when checks pass, for two weeks", () => {
    const r = rules("let assistant merge anything in okayed when checks pass for 2 weeks", [
      { effect: "allow", act: "github.pr.merge", res: "github:adrianmross/**", agent: "agent:mallory", ttl: 90 * DAY, uses: 100 },
    ]);
    expect(r.rules[0]).toMatchObject({
      effect: "allow",
      act: "github.pr.merge",
      res: "github:adrianmross/okayed/**",
      agent: "agent:assistant",
      until: NOW + 14 * DAY,
      when: [{ c: "checks.pass" }],
      budget: { uses: 100 },
    });
    expect(r.beyond.map((b) => b.field).sort()).toEqual(["aud", "res", "until"]);
    expect(decide(r.policy, "github.pr.merge", PR, NOW, { agent: "agent:assistant" })).toMatchObject({ verdict: "allow", when: [{ c: "checks.pass" }] });
    expect(decide(r.policy, "github.pr.merge", "github:adrianmross/matrix/pull/7@" + SHA, NOW, { agent: "agent:assistant" }).verdict).toBe("ask");
  });

  it("keeps a count to what was said", () => {
    const r = rules("auto-approve merges up to 10 times", [{ effect: "allow", act: "github.pr.merge", uses: 50 }]);
    expect(r.rules[0]!.budget).toEqual({ uses: 10 });
    expect(r.beyond[0]).toMatchObject({ field: "uses", asked: "50", granted: "10" });
  });

  it("asks how long or how many when a risky standing allow has no bound", () => {
    const r = run("auto-approve merges", [{ effect: "allow", act: "github.pr.merge" }]);
    expect(r).toMatchObject({ kind: "question", options: ["for 1 day", "for 1 week", "up to 10 times", "forever"] });
  });

  it("honors “forever” as the person's choice, and warns", () => {
    const r = rules("auto-approve merges forever", [{ effect: "allow", act: "github.pr.merge", ttl: 3600 }]);
    expect(r.rules[0]!.until).toBeUndefined();
    expect(r.warnings[0]!.message).toMatch(/no end date and no budget/);
  });

  it("lets medium-risk standing allows run open-ended, with a note", () => {
    const r = rules("auto-approve staging deploys", [{ effect: "allow", act: "site.deploy" }]);
    expect(r.rules[0]).toMatchObject({ act: "site.deploy", res: "site:*/staging" });
    expect(r.notes[0]).toMatch(/no end date/);
  });

  it("caps a standing policy at 30 days unless told “forever”", () => {
    const r = rules("auto-approve merges for 12 weeks", [{ effect: "allow", act: "github.pr.merge" }]);
    expect(r.rules[0]!.until).toBe(NOW + 30 * DAY);
    expect(r.beyond[0]).toMatchObject({ field: "until", granted: "30 d" });
  });
});

describe("narrowPolicy: drafts that go further than the words", () => {
  it("narrows a draft that auto-approves all of GitHub to reads", () => {
    const r = rules("auto-approve read-only GitHub for 1 hour", [{ effect: "allow", act: "github.*", ttl: 3600 }]);
    expect(r.rules[0]).toMatchObject({ effect: "allow", act: "github.read" });
    expect(r.beyond[0]).toMatchObject({ field: "act", asked: "github.*", granted: "github.read" });
  });

  it("refuses to loosen ask into allow", () => {
    const r = rules("ask me before anything that spends money", [{ effect: "allow", act: "spend.money" }]);
    expect(r.rules[0]).toMatchObject({ effect: "ask", act: "spend.money" });
    expect(r.beyond[0]).toMatchObject({ field: "effect", asked: "allow", granted: "ask" });
  });

  it("can't stretch a stated duration", () => {
    const r = rules("auto-approve reading github for 1 hour", [{ effect: "allow", act: "github.read", ttl: 30 * DAY }]);
    expect(r.rules[0]!.until).toBe(NOW + 3600);
    expect(r.beyond[0]).toMatchObject({ field: "until" });
  });

  it("drops rules about things the person didn't mention", () => {
    const r = rules("auto-approve reading github", [{ effect: "allow", act: "site.deploy" }]);
    expect(r.rules).toEqual([]);
    expect(r.beyond[0]).toMatchObject({ why: "you didn't mention this" });
  });

  it("keeps a resource scoped to the repo the person named", () => {
    const r = rules("auto-approve reads on okayed", [{ effect: "allow", act: "github.read", res: "github:**" }]);
    expect(r.rules[0]!.res).toBe("github:adrianmross/okayed/**");
  });

  it("drops conditions verifiers can't check", () => {
    const r = rules("auto-approve merges for 1 day", [{ effect: "allow", act: "github.pr.merge", when: [{ c: "vibes.good" }] }]);
    expect(r.rules[0]!.when).toBeUndefined();
    expect(r.beyond[0]).toMatchObject({ field: "when" });
  });

  it("stricter than said is fine", () => {
    const r = rules("ask me before anything that spends money", [{ effect: "deny", act: "spend.money" }]);
    expect(r.rules[0]).toMatchObject({ effect: "deny" });
    expect(r.beyond).toEqual([]);
  });

  it("asks when the sentence has no effect word", () => {
    expect(run("github stuff", [{ effect: "allow", act: "github.read" }]).kind).toBe("question");
  });
});
