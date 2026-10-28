import { policyClauses, type PolicyClause } from "./anchors.ts";
import { CATALOG } from "./catalog.ts";
import { shortDuration } from "./format.ts";
import { lint, type LintWarning } from "./policy.ts";
import { matchAct, parseRes, ruleScopeOf } from "./resource.ts";
import type { Beyond, Condition, Effect, Layer, Policy, Rule, Targets, Unix } from "./types.ts";

export interface PolicyDraftInput {
  utterance: string;
  /** The model's draft: `{ rules: [...] }` with the fields of `DraftRule`. Untrusted. */
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

/** A standing policy as the model may draft it. Every bound is optional and can only narrow what was said. */
export interface DraftRule {
  effect: Effect;
  act: string;
  res?: string;
  agent?: string;
  /** How long the policy stands, seconds. */
  ttl?: number;
  /** Total auto-approvals, and total risk. */
  uses?: number;
  risk?: number;
  /** Per-grant caps. */
  maxTtl?: number;
  maxUses?: number;
  when?: Condition[];
}

const STRICT: Record<Effect, number> = { allow: 0, ask: 1, deny: 2 };
const KNOWN_CONDITIONS = new Set(["checks.pass"]);

const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : undefined);
const str = (x: unknown): string | undefined => (typeof x === "string" && x.trim() ? x.trim() : undefined);

function clauseFor(act: string, clauses: PolicyClause[]): PolicyClause | undefined {
  return clauses.find((c) => c.effect && c.acts.some((x) => x === act || matchAct(x, act) || matchAct(act, x))) ?? clauses.find((c) => c.effect && c.everything);
}

/** The narrowest resource pattern a clause names: a known target, a repo, a site's environment, an environment anywhere. */
function clauseScope(c: PolicyClause): string | undefined {
  if (c.named.length === 1) return c.named[0];
  if (c.repos.length === 1) return `github:${c.repos[0]}/**`;
  if (c.sites.length === 1) return c.envs.length === 1 ? `site:${c.sites[0]}/${c.envs[0]}` : `site:${c.sites[0]}/*`;
  if (c.envs.length === 1) return `site:*/${c.envs[0]}`;
  return undefined;
}

/** True if pattern `a` covers no more than pattern `b`. */
function within(a: string, b: string): boolean {
  if (a === b) return true;
  // An exact scope (a named target) admits only itself.
  if (!b.includes("*")) return false;
  if (b.endsWith("/**")) return a === b.slice(0, -3) || a.startsWith(b.slice(0, -2));
  if (b.endsWith("/*")) return a.startsWith(b.slice(0, -1)) && !a.slice(b.length - 1).includes("/");
  if (b.startsWith("site:*/")) return /^site:[^/*]+\//.test(a) && a.endsWith(b.slice(6));
  return false;
}

/**
 * Turns a model's policy draft into standing policies for the person's layer, kept to what each clause of the
 * sentence says: the actions it names, an effect no looser than its words, its targets, its agent, its duration and
 * count. How open-ended a policy is stays the person's call; the draft can only make it narrower.
 */
export function narrowPolicy(input: PolicyDraftInput): PolicyDraftResult {
  const { now } = input;
  const clauses = policyClauses(input.utterance, input.targets);
  const beyond: Beyond[] = [];
  const notes: string[] = [];
  const raw = input.proposal && typeof input.proposal === "object" ? (input.proposal as { rules?: unknown }).rules : undefined;
  const drafts = (Array.isArray(raw) ? raw : []).filter((r): r is Record<string, unknown> => !!r && typeof r === "object");

  if (!clauses.some((c) => c.effect)) {
    return { kind: "question", question: "Should this be allowed, ask you, or be blocked? Try “always allow …”, “ask me before …” or “never …”.", options: [], beyond };
  }

  const rules: Rule[] = [];
  for (const d of drafts) {
    const act = str(d.act) ?? "";
    const effect = d.effect === "allow" || d.effect === "ask" || d.effect === "deny" ? d.effect : undefined;
    if (!act || !effect) {
      beyond.push({ field: "act", asked: JSON.stringify(d).slice(0, 80), why: "not a rule okayed can read" });
      continue;
    }
    if (!Object.keys(CATALOG).some((a) => matchAct(act, a))) {
      beyond.push({ field: "act", asked: act, why: "matches no action okayed knows" });
      continue;
    }
    const clause = clauseFor(act, clauses);
    if (!clause?.effect) {
      beyond.push({ field: "act", asked: `${effect} ${act}`, why: "you didn't mention this" });
      continue;
    }

    // Action: no wider than the family the clause names.
    let finalAct = act;
    if (clause.acts.length && !clause.acts.some((x) => matchAct(x, act))) {
      const narrower = clause.acts.find((x) => matchAct(act, x));
      if (!narrower) {
        beyond.push({ field: "act", asked: act, why: `you said ${clause.acts.join(", ")}` });
        continue;
      }
      beyond.push({ field: "act", asked: act, granted: narrower, why: `you said ${narrower}, not all of ${act}` });
      finalAct = narrower;
    }

    // Effect: no looser than the words.
    let finalEffect: Effect = effect;
    if (STRICT[effect] < STRICT[clause.effect]) {
      beyond.push({ field: "effect", asked: effect, granted: clause.effect, why: `you said “${clause.text}”` });
      finalEffect = clause.effect;
    }
    const rule: Rule = { id: `${finalEffect}:${finalAct}:${now.toString(36)}${rules.length}`, effect: finalEffect, act: finalAct, note: clause.text };

    // Targets: within what the clause names; a draft may name less.
    const scope = clauseScope(clause);
    const asked = str(d.res);
    if (asked && asked !== "**" && (!scope || within(asked, scope))) {
      if (!asked.includes(":")) beyond.push({ field: "res", asked, why: "not a resource pattern" });
      else rule.res = asked;
    } else if (scope) {
      if (asked && asked !== "**") beyond.push({ field: "res", asked, granted: scope, why: `you said ${scope}` });
      rule.res = scope;
    }

    // Agent: the one the clause names; a draft can't pick another.
    const agent = str(d.agent);
    if (clause.agents.length === 1) {
      if (agent && agent !== clause.agents[0]) beyond.push({ field: "aud", asked: agent, granted: clause.agents[0]!, why: `you said ${clause.agents[0]}` });
      rule.agent = clause.agents[0]!;
    } else if (agent && input.targets.agents.includes(agent)) {
      rule.agent = agent;
    }

    // Duration: what was said, capped at the standing maximum unless the person said "forever".
    const draftTtl = num(d.ttl);
    let life = clause.ttl;
    if (draftTtl !== undefined) {
      if (life !== undefined && draftTtl > life) beyond.push({ field: "until", asked: shortDuration(draftTtl), granted: shortDuration(life), why: `you said ${shortDuration(life)}` });
      else if (!clause.unbounded) life = draftTtl;
    }
    if (life !== undefined) rule.until = now + life;

    // Count: what was said; a draft may only lower it. A risk budget from the draft only narrows.
    const draftUses = num(d.uses);
    let uses = clause.uses;
    if (draftUses !== undefined) {
      if (uses !== undefined && draftUses > uses) beyond.push({ field: "uses", asked: String(draftUses), granted: String(uses), why: `you said ${uses}` });
      else uses = draftUses;
    }
    const risk = num(d.risk);
    if (finalEffect === "allow" && (uses !== undefined || risk !== undefined)) rule.budget = { ...(uses !== undefined ? { uses } : {}), ...(risk !== undefined ? { risk } : {}) };

    // Per-grant caps and conditions: only narrow.
    const maxTtl = num(d.maxTtl);
    const maxUses = num(d.maxUses);
    if (maxTtl !== undefined) rule.maxTtl = maxTtl;
    if (maxUses !== undefined) rule.maxUses = maxUses;
    const when = [...clause.conditions];
    for (const c of Array.isArray(d.when) ? (d.when as unknown[]) : []) {
      const name = c && typeof c === "object" ? str((c as { c?: unknown }).c) : undefined;
      if (!name) continue;
      if (!KNOWN_CONDITIONS.has(name)) beyond.push({ field: "when", asked: name, why: "not a condition verifiers can check" });
      else if (!when.some((w) => w.c === name)) when.push({ c: name });
    }
    if (when.length && finalEffect === "allow") rule.when = when;

    rules.push(rule);
  }

  const layers = input.policy.layers.map((l) => (l.name === input.layer ? { ...l, rules: [...l.rules.filter((r) => r.until === undefined || r.until > now), ...rules] } : l));
  const layer = layers.find((l) => l.name === input.layer);
  if (!layer) return { kind: "question", question: `There is no layer called ${input.layer}.`, options: input.policy.layers.map((l) => l.name), beyond };
  const policy: Policy = { layers };
  return { kind: "policy", rules, layer, policy, beyond, notes, warnings: lint(policy, now).filter((w) => rules.some((r) => r.id === w.rule)) };
}

/**
 * "Always allow…": the narrowest standing rule that covers a request like this one again. A pull request becomes its
 * repository, a deploy keeps its site and environment, a purchase keeps its exact amount, a registered type follows
 * its `ruleScope` (or stays exact); the agent and any conditions carry over. The person widens it in the editor.
 */
export function ruleFromRequest(r: { act: string; res: string[]; aud?: string; when?: Condition[] }, id: string): Rule {
  const first = r.res[0] ? parseRes(r.res[0]) : null;
  const res =
    first?.kind === "github.pr" || first?.kind === "github.repo" ? `github:${first.owner}/${first.repo}/**`
    : first?.kind === "site" ? `site:${first.host}/${first.env}`
    : first?.kind === "custom" ? (ruleScopeOf(r.res[0]!) ?? r.res[0])
    : r.res[0];
  const rule: Rule = { id, effect: "allow", act: r.act };
  if (res) rule.res = res;
  if (r.aud) rule.agent = r.aud;
  if (r.when?.length) rule.when = r.when;
  return rule;
}
