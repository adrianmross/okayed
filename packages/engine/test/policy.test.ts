import { describe, expect, it } from "vitest";
import { BASELINE, decide, lint, type Policy } from "../src/index.ts";
import { NOW, policy, SHA } from "./fixtures.ts";

const pr = `github:adrianmross/okayed/pull/182@${SHA}`;

describe("decide", () => {
  it("asks by default and names the asking layer", () => {
    const d = decide(policy, "github.pr.merge", pr, NOW);
    expect(d.verdict).toBe("ask");
    expect(d.decidedBy).toBe("okayed");
    expect(d.reason).toMatch(/merges always need your okay/);
    expect(d.layers.map((l) => l.verdict)).toEqual(["ask", "ask"]);
  });

  it("denies unknown actions at the top layer", () => {
    const d = decide(policy, "aws.iam.createUser", "github:a/b", NOW);
    expect(d.verdict).toBe("deny");
    expect(d.decidedBy).toBe("okayed");
  });

  it("allows only when every layer allows", () => {
    const p: Policy = { layers: [BASELINE, { name: "you", default: "ask", rules: [{ id: "r", effect: "allow", act: "github.read" }] }] };
    expect(decide(p, "github.read", "github:adrianmross/okayed", NOW).verdict).toBe("allow");
  });

  it("a lower layer cannot widen a higher one", () => {
    const p: Policy = { layers: [BASELINE, { name: "you", default: "ask", rules: [{ id: "w", effect: "allow", act: "github.*" }] }] };
    const d = decide(p, "github.pr.merge", pr, NOW);
    expect(d.verdict).toBe("ask");
    expect(d.decidedBy).toBe("okayed");
  });

  it("a lower layer can narrow, and its deny names it", () => {
    const p: Policy = { layers: [BASELINE, { name: "you", default: "ask", rules: [{ id: "n", effect: "deny", act: "github.read", res: "github:adrianmross/matrix" }] }] };
    const d = decide(p, "github.read", "github:adrianmross/matrix", NOW);
    expect(d.verdict).toBe("deny");
    expect(d.decidedBy).toBe("you");
    expect(decide(p, "github.read", "github:adrianmross/okayed", NOW).verdict).toBe("ask");
  });

  it("most specific rule wins inside a layer; ties go to the strictest", () => {
    const layer = {
      name: "you",
      default: "ask" as const,
      rules: [
        { id: "a", effect: "allow" as const, act: "github.read" },
        { id: "b", effect: "deny" as const, act: "github.read", res: "github:adrianmross/matrix" },
        { id: "c", effect: "ask" as const, act: "github.read" },
      ],
    };
    const p: Policy = { layers: [BASELINE, layer] };
    expect(decide(p, "github.read", "github:adrianmross/matrix", NOW).layers[1]!.rule!.id).toBe("b");
    expect(decide(p, "github.read", "github:adrianmross/okayed", NOW).layers[1]!.rule!.id).toBe("c");
  });

  it("expired rules stop applying", () => {
    const p: Policy = { layers: [BASELINE, { name: "you", default: "ask", rules: [{ id: "r", effect: "allow", act: "github.read", until: NOW }] }] };
    expect(decide(p, "github.read", "github:a/b", NOW).verdict).toBe("ask");
    expect(decide(p, "github.read", "github:a/b", NOW - 1).verdict).toBe("allow");
  });

  it("caps are the minimum across layers", () => {
    const p: Policy = {
      layers: [
        { name: "org", default: "deny", rules: [{ id: "o", effect: "allow", act: "github.read", maxTtl: 600, maxUses: 10 }] },
        { name: "you", default: "abstain", rules: [{ id: "y", effect: "allow", act: "github.read", maxTtl: 1200, maxUses: 3 }] },
      ],
    };
    expect(decide(p, "github.read", "github:a/b", NOW).caps).toEqual({ ttl: 600, uses: 3 });
  });

  it("all-abstain denies", () => {
    expect(decide({ layers: [{ name: "x", default: "abstain", rules: [] }] }, "github.read", "github:a/b", NOW).verdict).toBe("deny");
  });
});

describe("lint", () => {
  it("flags a rule that a higher layer makes ineffective", () => {
    const p: Policy = { layers: [BASELINE, { name: "you", default: "ask", rules: [{ id: "w", effect: "allow", act: "github.pr.merge" }] }] };
    const w = lint(p, NOW);
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toMatch(/can only narrow/);
  });

  it("flags unknown actions and expired rules", () => {
    const p: Policy = { layers: [BASELINE, { name: "you", default: "ask", rules: [{ id: "u", effect: "ask", act: "aws.*" }, { id: "e", effect: "allow", act: "github.read", until: NOW - 5 }] }] };
    expect(lint(p, NOW).map((w) => w.rule)).toEqual(["u", "e"]);
  });

  it("is quiet for a sane policy", () => {
    const p: Policy = { layers: [BASELINE, { name: "you", default: "ask", rules: [{ id: "r", effect: "allow", act: "github.read", until: NOW + 3600 }] }] };
    expect(lint(p, NOW)).toEqual([]);
  });
});
