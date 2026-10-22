import { describe, expect, it } from "vitest";
import { WorkersAIDrafter } from "../src/adapters.ts";

const ctx = { now: 0, targets: { repos: [], prs: [], sites: [], agents: [] }, pending: [], actions: [] };

function fakeAi(response: unknown) {
  const calls: unknown[] = [];
  return { calls, ai: { run: async (_m: string, input: unknown) => (calls.push(input), { response }) } as unknown as Ai };
}

describe("WorkersAIDrafter", () => {
  it("asks Llama 3.3 for JSON and passes the draft through", async () => {
    const { ai, calls } = fakeAi({ intent: "grant", grant: { act: "github.pr.merge", res: ["github:a/b/pull/1@" + "a".repeat(40)] } });
    const d = await new WorkersAIDrafter(ai, "@cf/meta/llama-3.3-70b-instruct-fp8-fast").draft("I approve merging #1", ctx);
    expect(d).toMatchObject({ intent: "grant", grant: { act: "github.pr.merge" } });
    expect((calls[0] as { response_format: { type: string } }).response_format.type).toBe("json_schema");
  });

  it("parses string responses and policy intents", async () => {
    const { ai } = fakeAi(JSON.stringify({ intent: "policy", policy: { rules: [{ effect: "ask", act: "spend.money" }] } }));
    expect(await new WorkersAIDrafter(ai, "m").draft("ask me before spending", ctx)).toMatchObject({ intent: "policy" });
  });

  it("throws on junk so the fallback drafter takes over", async () => {
    const { ai } = fakeAi("not json");
    await expect(new WorkersAIDrafter(ai, "m").draft("x", ctx)).rejects.toThrow();
  });
});
