import { CATALOG, defaultPolicy, describeRequestSentence } from "@okayed/engine";
import { describe, expect, it } from "vitest";
import { HeuristicDrafter, OpenAICompatibleDrafter, chatCard, type Card, type Drafter } from "../src/index.ts";
import { CASES, NOW, TARGETS } from "./interpret.cases.ts";

/**
 * Compares drafters on the same cases. The heuristic always runs and guards a baseline; models run when configured:
 *
 *   EVAL_MODELS="cf:@cf/meta/llama-3.3-70b-instruct-fp8-fast,cf:@cf/openai/gpt-oss-120b" \
 *     CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… pnpm --filter @okayed/core test interpret
 *   EVAL_MODELS="openai:gpt-5-mini" OPENAI_API_KEY=… …
 *   EVAL_MODELS="compat:llama3.3" OPENAI_BASE_URL=http://localhost:11434/v1 …
 */

function drafters(): Drafter[] {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  const out: Drafter[] = [];
  for (const spec of (env.EVAL_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [provider, ...rest] = spec.split(":");
    const model = rest.join(":");
    if (provider === "cf") out.push(new OpenAICompatibleDrafter({ baseUrl: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`, apiKey: env.CLOUDFLARE_API_TOKEN, model, name: model.replace(/^@cf\//, "") }));
    else if (provider === "openai") out.push(new OpenAICompatibleDrafter({ baseUrl: "https://api.openai.com/v1", apiKey: env.OPENAI_API_KEY, model, temperature: null }));
    else if (provider === "compat") out.push(new OpenAICompatibleDrafter({ baseUrl: env.OPENAI_BASE_URL ?? "http://localhost:11434/v1", apiKey: env.OPENAI_API_KEY, model }));
  }
  return out;
}

interface Row {
  drafter: string;
  intent: number;
  outcome: number;
  /** Average number of things the engine had to cut from correct drafts: lower means closer to the words. */
  cuts: number;
  p50: number;
  misses: string[];
}

async function score(d: Drafter): Promise<Row> {
  const policy = defaultPolicy();
  const times: number[] = [];
  let intent = 0;
  let outcome = 0;
  let cuts = 0;
  const misses: string[] = [];
  for (const c of CASES) {
    const ctx = { now: NOW, targets: TARGETS, actions: Object.keys(CATALOG), pending: c.pending.map((r) => ({ id: r.id, sentence: describeRequestSentence(r), act: r.act, res: r.res })) };
    const t0 = performance.now();
    let card: Card;
    let drafted = "error";
    try {
      const draft = await d.draft(c.said, ctx);
      drafted = draft.intent;
      card = chatCard("c_eval", c.said, draft, { policy, targets: TARGETS, pending: c.pending, now: NOW });
    } catch (e) {
      card = { id: "c_eval", kind: "reply", source: "chat", status: "closed", createdAt: NOW, sentence: String(e), allows: [], doesNot: [], beyond: [], notes: [] };
    }
    times.push(performance.now() - t0);
    if (drafted === c.intent) intent++;
    if (c.ok(card)) {
      outcome++;
      cuts += card.beyond.length;
    } else misses.push(`“${c.said}” → expected ${c.expect}; got ${card.kind}: ${card.sentence}`);
  }
  times.sort((a, b) => a - b);
  return { drafter: d.name, intent, outcome, cuts: outcome ? cuts / outcome : 0, p50: times[Math.floor(times.length / 2)]!, misses };
}

function table(rows: Row[]): string {
  const n = CASES.length;
  const lines = ["| Drafter | Intent | Outcome | Cuts per correct draft | p50 |", "|---|---|---|---|---|"];
  for (const r of rows) lines.push(`| ${r.drafter} | ${r.intent}/${n} | ${r.outcome}/${n} | ${r.cuts.toFixed(2)} | ${r.p50 < 1 ? "<1" : Math.round(r.p50)} ms |`);
  return lines.join("\n");
}

describe("interpreting people", () => {
  it("the heuristic holds its baseline", async () => {
    const r = await score(new HeuristicDrafter());
    console.log(`${table([r])}\n\nHeuristic misses:\n${r.misses.map((m) => `- ${m}`).join("\n")}`);
    expect(r.outcome).toBeGreaterThanOrEqual(BASELINE.outcome);
    expect(r.intent).toBeGreaterThanOrEqual(BASELINE.intent);
  });

  const models = drafters();
  it.skipIf(models.length === 0)("models, side by side", { timeout: 600_000 }, async () => {
    const rows = [await score(new HeuristicDrafter())];
    for (const d of models) rows.push(await score(d));
    console.log(`${table(rows)}\n\n${rows.slice(1).map((r) => `${r.drafter} misses:\n${r.misses.map((m) => `- ${m}`).join("\n")}`).join("\n\n")}`);
  });
});

/** What the heuristic gets today; raise it when it improves. */
const BASELINE = { outcome: 17, intent: 18 };
