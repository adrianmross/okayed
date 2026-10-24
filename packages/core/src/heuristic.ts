import { CATALOG, policyClauses } from "@okayed/engine";
import type { Draft, DraftContext, Drafter, PolicyProposalJSON } from "./ports.ts";

const POLICY_WORDS = /\b(?:auto[- ]?approve|always|never|ask me|from now on|don't ask|without asking|block|forbid|by default|rule)\b/i;
/** Standing-authority phrasing: "let assistant merge anything …", "whenever …", "up to 30 merges", "for 2 weeks". */
const STANDING_WORDS = /\b(?:let|allow) \w+ \w+ (?:anything|any|all|every)\b|\bwhenever\b|\bup to \d+ \w+|\bfor (?:\d+|a|one|two) (?:days?|weeks?)\b/i;

/**
 * A drafter with no model: plain rules over the sentence. Used offline, in tests, and as the fallback when the
 * model fails. Because the engine binds grants from the words itself, an empty grant draft is enough.
 */
export class HeuristicDrafter implements Drafter {
  readonly name = "heuristic";

  async draft(utterance: string, ctx: DraftContext): Promise<Draft> {
    if (POLICY_WORDS.test(utterance) || STANDING_WORDS.test(utterance)) {
      const rules: PolicyProposalJSON["rules"] = [];
      for (const c of policyClauses(utterance, ctx.targets)) {
        if (!c.effect) continue;
        const acts = c.acts.length ? c.acts : c.everything ? Object.keys(CATALOG) : [];
        for (const act of acts) {
          const rule: PolicyProposalJSON["rules"][number] = { effect: c.effect, act };
          if (c.ttl !== undefined) rule.ttl = c.ttl;
          rules.push(rule);
        }
      }
      if (rules.length) return { intent: "policy", policy: { rules } };
    }
    if (/\?\s*$/.test(utterance) && !/\b(?:can you|could you|please)\b/i.test(utterance)) {
      return { intent: "other", reply: "I turn okays into narrow grants. Say what to approve (\"I approve merging #182\") or set a rule (\"ask me before anything that spends money\")." };
    }
    return { intent: "grant", grant: {} };
  }

  async explain(): Promise<string | null> {
    return null;
  }
}

/** Uses `primary`, falling back to `fallback` when it throws or returns something unusable. */
export class FallbackDrafter implements Drafter {
  readonly name: string;
  constructor(
    private primary: Drafter,
    private fallback: Drafter = new HeuristicDrafter(),
  ) {
    this.name = `${primary.name} (fallback: ${fallback.name})`;
  }

  async draft(utterance: string, ctx: DraftContext): Promise<Draft> {
    try {
      const d = await this.primary.draft(utterance, ctx);
      if (d && (d.intent === "grant" || d.intent === "policy" || d.intent === "other")) return d;
    } catch {
      // fall through
    }
    return this.fallback.draft(utterance, ctx);
  }

  async explain(facts: string): Promise<string | null> {
    try {
      return await this.primary.explain(facts);
    } catch {
      return null;
    }
  }
}
