import { policyClauses, type PolicyClause } from "./anchors.ts";
import { CATALOG, riskAtLeast } from "./catalog.ts";
import { lint, type LintWarning } from "./policy.ts";
import { isPattern, matchAct } from "./resource.ts";
import type { Beyond, Effect, Layer, Policy, Rule, Targets, Unix } from "./types.ts";

export interface PolicyDraftInput {
  utterance: string;
  /** The model's draft: `{ rules: [{ effect, act, res?, ttl?, maxTtl?, maxUses? }] }`. Untrusted. */
  proposal: unknown;
  policy: Policy;
  /** Name of the layer the person edits. */
  layer: string;
  targets: Targets;
  now: Unix;
}

export type PolicyDraftResult =
  | { kind: "policy"; rules: Rule[]; layer: Layer; policy: Policy; beyond: Beyond[]; notes: string[]; warnings: LintWarning[] }
  | { kind: "question"; question: string; options: string[]; beyond: Beyond[] };

const STRICT: Record<Effect, number> = { allow: 0, ask: 1, deny: 2 };
/** Auto-approval rules expire; the person can always say it again. */
export const DEFAULT_ALLOW_LIFETIME = 8 * 3600;
export const MAX_ALLOW_LIFETIME = 24 * 3600;

interface RawRule {
  effect?: unknown;
  act?: unknown;
  res?: unknown;
  ttl?: unknown;
  maxTtl?: unknown;
  maxUses?: unknown;
}

function clauseFor(act: string, clauses: PolicyClause[]): PolicyClause | undefined {
  return (
    clauses.find((c) => c.effect && c.acts.some((x) => x === act || matchAct(x, act) || matchAct(act, x))) ??
    clauses.find((c) => c.effect && c.everything)
  );
}

function hours(s: number): string {
  return s >= 3600 && s % 3600 === 0 ? `${s / 3600} h` : `${Math.round(s / 60)} min`;
}

/**
 * Turns a model's policy draft into rules for the person's layer, keeping only what each clause of the sentence
 * says: the action family named, an effect no looser than the words, a lifetime for auto-approvals, and no
 * auto-approval of high-risk actions.
 */
export function narrowPolicy(input: PolicyDraftInput): PolicyDraftResult {
  const clauses = policyClauses(input.utterance, input.targets);
  const beyond: Beyond[] = [];
  const notes: string[] = [];
  const raw = (input.proposal && typeof input.proposal === "object" ? (input.proposal as { rules?: unknown }).rules : undefined) ?? [];
  const drafts: RawRule[] = Array.isArray(raw) ? raw.filter((r) => r && typeof r === "object") : [];

  if (!clauses.some((c) => c.effect)) {
    return {
      kind: "question",
      question: "Should the agent be allowed, asked about, or refused? Try \"auto-approve …\", \"ask me before …\" or \"never …\".",
      options: [],
      beyond,
    };
  }

  const rules: Rule[] = [];
  for (const d of drafts) {
    const act = typeof d.act === "string" ? d.act.trim() : "";
    const effect = d.effect === "allow" || d.effect === "ask" || d.effect === "deny" ? d.effect : undefined;
    if (!act || !effect) {
      beyond.push({ field: "act", asked: JSON.stringify(d).slice(0, 80), why: "not a rule okayed can read" });
      continue;
    }
    const acts = Object.keys(CATALOG).filter((a) => matchAct(act, a));
    if (acts.length === 0) {
      beyond.push({ field: "act", asked: act, why: "matches no action okayed knows" });
      continue;
    }
    const clause = clauseFor(act, clauses);
    if (!clause || !clause.effect) {
      beyond.push({ field: "act", asked: `${effect} ${act}`, why: "you didn't mention this" });
      continue;
    }
    let finalAct = act;
    // A clause that names a family can't be widened by the draft ("read-only GitHub" is not "github.*").
    if (clause.acts.length && !clause.acts.some((x) => matchAct(x, act))) {
      const narrower = clause.acts.find((x) => matchAct(act, x));
      if (!narrower) {
        beyond.push({ field: "act", asked: act, why: `you said ${clause.acts.join(", ")}` });
        continue;
      }
      beyond.push({ field: "act", asked: act, granted: narrower, why: `you said ${narrower}, not all of ${act}` });
      finalAct = narrower;
    }
    let finalEffect: Effect = effect;
    if (STRICT[effect] < STRICT[clause.effect]) {
      beyond.push({ field: "effect", asked: effect, granted: clause.effect, why: `you said "${clause.text}"` });
      finalEffect = clause.effect;
    }
    const covered = Object.keys(CATALOG).filter((a) => matchAct(finalAct, a));
    if (finalEffect === "allow") {
      const risky = covered.filter((a) => riskAtLeast(CATALOG[a]!.risk, "medium"));
      if (risky.length) {
        beyond.push({
          field: "effect",
          asked: `allow ${finalAct}`,
          granted: risky.length === covered.length ? `ask ${finalAct}` : `allow ${covered.filter((a) => !risky.includes(a)).join(", ")}`,
          why: "okayed only auto-approves low-risk, read-only actions",
        });
        if (risky.length === covered.length) finalEffect = "ask";
        else finalAct = covered.filter((a) => !risky.includes(a))[0]!;
      }
    }
    const rule: Rule = { id: `${finalEffect}:${finalAct}:${input.now.toString(36)}${rules.length}`, effect: finalEffect, act: finalAct };
    if (typeof d.res === "string" && d.res !== "**") {
      const repos = clause.repos;
      if (repos.length && !repos.some((r) => d.res === `github:${r}` || (d.res as string).startsWith(`github:${r}/`))) {
        beyond.push({ field: "res", asked: d.res, granted: `github:${repos[0]}/**`, why: `you said ${repos[0]}` });
        rule.res = `github:${repos[0]}/**`;
      } else if (!repos.length && isPattern(d.res) === false && !d.res.startsWith("github:") && !d.res.startsWith("site:") && !d.res.startsWith("money:")) {
        beyond.push({ field: "res", asked: d.res, why: "not a resource pattern" });
      } else {
        rule.res = d.res;
      }
    } else if (clause.repos.length === 1) {
      rule.res = `github:${clause.repos[0]}/**`;
    }
    if (finalEffect === "allow") {
      const said = clause.ttl;
      const asked = typeof d.ttl === "number" ? d.ttl : undefined;
      let life = said ?? DEFAULT_ALLOW_LIFETIME;
      if (life > MAX_ALLOW_LIFETIME) {
        beyond.push({ field: "until", asked: hours(life), granted: hours(MAX_ALLOW_LIFETIME), why: "auto-approval lasts at most a day" });
        life = MAX_ALLOW_LIFETIME;
      }
      if (asked !== undefined && asked > life) beyond.push({ field: "until", asked: hours(asked), granted: hours(life), why: said ? `you said ${hours(said)}` : "auto-approval defaults to 8 h" });
      else if (asked !== undefined && asked >= 60) life = asked;
      if (said === undefined) notes.push(`Auto-approval for ${finalAct} lasts ${hours(life)}; say "for …" to change it.`);
      rule.until = input.now + life;
    }
    if (typeof d.maxTtl === "number" && d.maxTtl > 0) rule.maxTtl = Math.floor(d.maxTtl);
    if (typeof d.maxUses === "number" && d.maxUses > 0) rule.maxUses = Math.floor(d.maxUses);
    rule.note = clause.text;
    rules.push(rule);
  }

  const layers = input.policy.layers.map((l) =>
    l.name === input.layer ? { ...l, rules: [...l.rules.filter((r) => r.until === undefined || r.until > input.now), ...rules] } : l,
  );
  const layer = layers.find((l) => l.name === input.layer);
  if (!layer) {
    return { kind: "question", question: `There is no layer called ${input.layer}.`, options: input.policy.layers.map((l) => l.name), beyond };
  }
  const policy: Policy = { layers };
  return { kind: "policy", rules, layer, policy, beyond, notes, warnings: lint(policy, input.now) };
}
