import { CATALOG, riskAtLeast, riskCost } from "./catalog.ts";
import { matchAct, matchRes } from "./resource.ts";
import type { Condition, Effect, Layer, Policy, Rule, Unix, Usage } from "./types.ts";

/** Who is asking and what has been spent; both optional so a bare "may this happen?" still works. */
export interface Context {
  agent?: string;
  usage?: Usage;
  /** Risk this use would draw from a budget. Defaults to the action's cost on the resources asked about. */
  cost?: number;
}

export interface LayerVerdict {
  layer: string;
  verdict: Effect | "abstain";
  /** The rule that decided, or undefined when the layer's default did. */
  rule?: Rule;
  why: string;
  /** Set when an `allow` rule matched but its budget can't cover this use, so the layer asks instead. */
  spent?: boolean;
  /** What the deciding rule's budget has left before this use. */
  left?: { uses?: number; risk?: number };
}

export interface Charge {
  layer: string;
  rule: string;
  cost: number;
}

export interface Decision {
  verdict: Effect;
  /** One sentence naming the first layer that refused or asked, or why it was allowed. */
  reason: string;
  /** The first layer whose verdict is the final one (deny, or the first ask). */
  decidedBy?: string;
  layers: LayerVerdict[];
  /** Tightest per-grant caps across the deciding rules of every layer. */
  caps: { ttl?: number; uses?: number };
  /** On allow: the rules whose budgets this use draws from, one per layer that allowed by a rule. */
  charges: Charge[];
  /** On allow: conditions the deciding rules require on the grant. */
  when: Condition[];
}

const STRICT: Record<Effect, number> = { allow: 0, ask: 1, deny: 2 };

function literal(p: string | undefined): number {
  return p === undefined ? 0 : p.replace(/\*/g, "").length;
}

/** Specificity: the action pattern weighs most, then the resource, then the agent. */
export function specificity(rule: Rule): number {
  return literal(rule.act) * 1_000_000 + literal(rule.res) * 1000 + literal(rule.agent);
}

export function ruleApplies(rule: Rule, act: string, res: string, now: Unix, agent?: string): boolean {
  if (rule.from !== undefined && now < rule.from) return false;
  if (rule.until !== undefined && now >= rule.until) return false;
  if (rule.agent !== undefined && (agent === undefined || !matchAct(rule.agent, agent))) return false;
  return matchAct(rule.act, act) && matchRes(rule.res, res);
}

/** What a rule's budget has left, and whether one more use at `cost` fits. */
export function budgetLeft(rule: Rule, usage: Usage | undefined, cost: number): { left?: LayerVerdict["left"]; fits: boolean } {
  if (!rule.budget) return { fits: true };
  const spent = usage?.[rule.id] ?? { uses: 0, risk: 0 };
  const left: NonNullable<LayerVerdict["left"]> = {};
  let fits = true;
  if (rule.budget.uses !== undefined) {
    left.uses = Math.max(0, rule.budget.uses - spent.uses);
    if (left.uses < 1) fits = false;
  }
  if (rule.budget.risk !== undefined) {
    left.risk = Math.max(0, rule.budget.risk - spent.risk);
    if (left.risk < cost) fits = false;
  }
  return { left, fits };
}

/** The verdict of one layer: the most specific matching rule; on a tie, the strictest. A spent budget asks. */
export function decideLayer(layer: Layer, act: string, res: string, now: Unix, ctx: Context = {}): LayerVerdict {
  let best: Rule | undefined;
  for (const rule of layer.rules) {
    if (!ruleApplies(rule, act, res, now, ctx.agent)) continue;
    if (!best || specificity(rule) > specificity(best) || (specificity(rule) === specificity(best) && STRICT[rule.effect] > STRICT[best.effect])) {
      best = rule;
    }
  }
  if (best) {
    const why = best.note ?? `rule "${best.id}" says ${best.effect}`;
    if (best.effect !== "allow") return { layer: layer.name, verdict: best.effect, rule: best, why };
    const { left, fits } = budgetLeft(best, ctx.usage, ctx.cost ?? riskCost(act, [res]));
    const v: LayerVerdict = { layer: layer.name, verdict: fits ? "allow" : "ask", rule: best, why: fits ? why : `${why}, but its budget is spent` };
    if (left) v.left = left;
    if (!fits) v.spent = true;
    return v;
  }
  if (layer.default === "abstain") return { layer: layer.name, verdict: "abstain", why: "no rule here; leaves it to the layer above" };
  return { layer: layer.name, verdict: layer.default, why: layer.default === "deny" ? `nothing here covers ${act}` : `no rule here, so ${layer.default}` };
}

function sentence(v: LayerVerdict, act: string): string {
  const verb = CATALOG[act]?.verb ?? act;
  switch (v.verdict) {
    case "deny":
      return `Refused by ${v.layer}: ${v.why}.`;
    case "ask":
      return `Needs your okay (${v.layer}: ${v.why}).`;
    default:
      return `Allowed: every layer lets the agent ${verb} this.`;
  }
}

/**
 * Decides one action on one resource. Allowed only if every layer allows; any deny wins, then any ask.
 * Abstaining layers are skipped. A policy whose layers all abstain denies.
 */
export function decide(policy: Policy, act: string, res: string, now: Unix, ctx: Context = {}): Decision {
  const layers = policy.layers.map((l) => decideLayer(l, act, res, now, ctx));
  const caps: Decision["caps"] = {};
  for (const v of layers) {
    if (v.verdict === "abstain" || !v.rule) continue;
    if (v.rule.maxTtl !== undefined) caps.ttl = Math.min(caps.ttl ?? Infinity, v.rule.maxTtl);
    if (v.rule.maxUses !== undefined) caps.uses = Math.min(caps.uses ?? Infinity, v.rule.maxUses);
  }
  const voting = layers.filter((v) => v.verdict !== "abstain");
  const none = { charges: [], when: [] };
  if (voting.length === 0) return { verdict: "deny", reason: "Refused: no layer has a rule for this.", layers, caps, ...none };
  const deny = voting.find((v) => v.verdict === "deny");
  if (deny) return { verdict: "deny", reason: sentence(deny, act), decidedBy: deny.layer, layers, caps, ...none };
  const ask = voting.find((v) => v.verdict === "ask");
  if (ask) return { verdict: "ask", reason: sentence(ask, act), decidedBy: ask.layer, layers, caps, ...none };
  const cost = ctx.cost ?? riskCost(act, [res]);
  const charges = voting.filter((v) => v.rule?.budget).map((v) => ({ layer: v.layer, rule: v.rule!.id, cost }));
  const when = voting.flatMap((v) => v.rule?.when ?? []);
  return { verdict: "allow", reason: sentence(voting[0]!, act), layers, caps, charges, when };
}

/** Decides an action over several resources, as one grant: the strictest per-resource verdict wins. */
export function decideAll(policy: Policy, act: string, res: string[], now: Unix, ctx: Context = {}): Decision {
  const c: Context = { ...ctx, cost: ctx.cost ?? riskCost(act, res) };
  const all = res.map((r) => decide(policy, act, r, now, c));
  let worst = all[0] ?? decide(policy, act, "", now, c);
  for (const d of all) if (STRICT[d.verdict] > STRICT[worst.verdict]) worst = d;
  const caps: Decision["caps"] = {};
  for (const d of all) {
    if (d.caps.ttl !== undefined) caps.ttl = Math.min(caps.ttl ?? Infinity, d.caps.ttl);
    if (d.caps.uses !== undefined) caps.uses = Math.min(caps.uses ?? Infinity, d.caps.uses);
  }
  if (worst.verdict !== "allow") return { ...worst, caps };
  // One grant covers every resource, so it draws once from each rule, and carries every condition any rule asks for.
  const charges = [...new Map(all.flatMap((d) => d.charges).map((ch) => [`${ch.layer}/${ch.rule}`, ch])).values()];
  const when = [...new Map(all.flatMap((d) => d.when).map((w) => [`${w.c}=${w.v}`, w])).values()];
  return { ...worst, caps, charges, when };
}

export interface LintWarning {
  layer: string;
  rule: string;
  message: string;
}

/**
 * Explains a policy: rules a layer above makes ineffective, rules that matched nothing or have ended, and standing
 * authority over risky actions with no end date and no budget. Warnings, not refusals: the person decides.
 */
export function lint(policy: Policy, now: Unix): LintWarning[] {
  const out: LintWarning[] = [];
  policy.layers.forEach((layer, i) => {
    for (const rule of layer.rules) {
      const warn = (message: string) => out.push({ layer: layer.name, rule: rule.id, message });
      const acts = Object.keys(CATALOG).filter((a) => matchAct(rule.act, a));
      if (acts.length === 0) {
        warn(`"${rule.act}" matches no known action`);
        continue;
      }
      if (rule.until !== undefined && rule.until <= now) warn("has ended and no longer applies");
      if (rule.effect === "allow" && rule.until === undefined && !rule.budget && acts.some((a) => riskAtLeast(CATALOG[a]!.risk, "high"))) {
        warn(`lets agents ${acts.map((a) => CATALOG[a]!.verb).join(", ")} with no end date and no budget`);
      }
      if (i === 0 || rule.effect === "deny") continue;
      const above: Policy = { layers: policy.layers.slice(0, i) };
      const ctx: Context = rule.agent && !rule.agent.includes("*") ? { agent: rule.agent } : {};
      const verdictAbove = (a: string) => (rule.res && !rule.res.includes("*") ? decide(above, a, rule.res, now, ctx) : decideIgnoringRes(above, a, now, ctx));
      if (acts.every((a) => STRICT[verdictAbove(a).verdict] > STRICT[rule.effect])) {
        const d = verdictAbove(acts[0]!);
        warn(`${rule.effect}s ${rule.act}, but ${d.decidedBy ?? "a layer above"} ${d.verdict === "deny" ? "denies" : "asks"}; a layer can only narrow the one above, so this has no effect`);
      }
    }
  });
  return out;
}

function decideIgnoringRes(policy: Policy, act: string, now: Unix, ctx: Context): Decision {
  const stripped: Policy = { layers: policy.layers.map((l) => ({ ...l, rules: l.rules.filter((r) => r.res === undefined || r.res === "**") })) };
  return decide(stripped, act, "", now, ctx);
}
