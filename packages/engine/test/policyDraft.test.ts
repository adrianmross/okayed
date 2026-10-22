import { describe, expect, it } from "vitest";
import { decide, narrowPolicy } from "../src/index.ts";
import { NOW, policy, SHA, targets } from "./fixtures.ts";

const SAID = "auto-approve read-only GitHub for 1 hour; ask me before anything that spends money";

function run(utterance: string, rules: unknown[]) {
  return narrowPolicy({ utterance, proposal: { rules }, policy, layer: "you", targets, now: NOW });
}

describe("narrowPolicy", () => {
  it("turns the example sentence into two rules", () => {
    const r = run(SAID, [
      { effect: "allow", act: "github.read", ttl: 3600 },
      { effect: "ask", act: "spend.money" },
    ]);
    if (r.kind !== "policy") throw new Error(r.question);
    expect(r.rules.map((x) => [x.effect, x.act, x.until])).toEqual([
      ["allow", "github.read", NOW + 3600],
      ["ask", "spend.money", undefined],
    ]);
    expect(r.beyond).toEqual([]);
    expect(decide(r.policy, "github.read", "github:adrianmross/okayed", NOW).verdict).toBe("allow");
    expect(decide(r.policy, "github.read", "github:adrianmross/okayed", NOW + 3600).verdict).toBe("ask");
  });

  it("narrows a draft that auto-approves all of GitHub to reads", () => {
    const r = run(SAID, [{ effect: "allow", act: "github.*", ttl: 3600 }]);
    if (r.kind !== "policy") throw new Error();
    expect(r.rules[0]).toMatchObject({ effect: "allow", act: "github.read" });
    expect(r.beyond[0]).toMatchObject({ field: "act", asked: "github.*", granted: "github.read" });
  });

  it("refuses to loosen ask into allow", () => {
    const r = run(SAID, [{ effect: "allow", act: "spend.money" }]);
    if (r.kind !== "policy") throw new Error();
    expect(r.rules[0]).toMatchObject({ effect: "ask", act: "spend.money" });
    expect(r.beyond[0]).toMatchObject({ field: "effect", asked: "allow", granted: "ask" });
  });

  it("never auto-approves merges, even if the person asks", () => {
    const r = run("auto-approve merges", [{ effect: "allow", act: "github.pr.merge" }]);
    if (r.kind !== "policy") throw new Error();
    expect(r.rules[0]).toMatchObject({ effect: "ask" });
    expect(decide(r.policy, "github.pr.merge", `github:a/b/pull/1@${SHA}`, NOW).verdict).toBe("ask");
  });

  it("drops rules about things the person didn't mention", () => {
    const r = run(SAID, [{ effect: "allow", act: "site.deploy" }]);
    if (r.kind !== "policy") throw new Error();
    expect(r.rules).toEqual([]);
    expect(r.beyond[0]).toMatchObject({ why: "you didn't mention this" });
  });

  it("caps an auto-approval's lifetime to what was said", () => {
    const r = run(SAID, [{ effect: "allow", act: "github.read", ttl: 86400 * 30 }]);
    if (r.kind !== "policy") throw new Error();
    expect(r.rules[0]!.until).toBe(NOW + 3600);
    expect(r.beyond[0]).toMatchObject({ field: "until" });
  });

  it("gives unstated auto-approvals a default lifetime and says so", () => {
    const r = run("auto-approve reading github", [{ effect: "allow", act: "github.read" }]);
    if (r.kind !== "policy") throw new Error();
    expect(r.rules[0]!.until).toBe(NOW + 8 * 3600);
    expect(r.notes[0]).toMatch(/lasts 8 h/);
  });

  it("keeps a resource scoped to the repo the person named", () => {
    const r = run("auto-approve reads on okayed", [{ effect: "allow", act: "github.read", res: "github:**" }]);
    if (r.kind !== "policy") throw new Error();
    expect(r.rules[0]!.res).toBe("github:adrianmross/okayed/**");
  });

  it("stricter-than-said is fine", () => {
    const r = run(SAID, [{ effect: "deny", act: "spend.money" }]);
    if (r.kind !== "policy") throw new Error();
    expect(r.rules[0]).toMatchObject({ effect: "deny" });
    expect(r.beyond).toEqual([]);
  });

  it("asks when the sentence has no effect word", () => {
    expect(run("github stuff", [{ effect: "allow", act: "github.read" }]).kind).toBe("question");
  });
});
