import { describe, expect, it } from "vitest";
import { doesNotAllowFor, narrowGrant, sentenceFor } from "../src/index.ts";
import { mergeReq, NOW, policy, targets } from "./fixtures.ts";

describe("explain", () => {
  it("says what a merge grant allows and doesn't", () => {
    const r = narrowGrant({ utterance: "I approve merging #182", proposal: {}, requests: [mergeReq], targets, policy, now: NOW });
    if (r.kind !== "grant") throw new Error();
    expect(sentenceFor(r.draft)).toBe("Lets assistant merge PR #182 in adrianmross/okayed at 3f9a1c2, once, within the next 15 minutes.");
    const not = doesNotAllowFor(r.draft);
    expect(not).toContain("merge any other pull request");
    expect(not).toContain("merge #182 if it changes after 3f9a1c2");
    expect(not).toContain("a second use");
  });
});
