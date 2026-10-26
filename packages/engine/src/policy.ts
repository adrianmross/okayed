import { CATALOG, riskCost } from "./catalog.ts";
import { matchAct, matchRes } from "./resource.ts";
import type { Condition, Effect, Layer, Policy, Rule, SharedBudget, Unix, Usage } from "./types.ts";

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

/** A draw on a budget: a rule's own (`key` = rule id) or a shared pool (`key` = `budget:<id>`). */
export interface Charge {
  key: string;
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
  /** On allow: every rule that allowed it and every shared pool it draws on. Counted always; only budgets run out. */
  charges: Charge[];
  /** Shared pools that count every okay, yours included: drawn even when you approve by hand. */
  tallies: Charge[];
  /** When a spent budget is why this asks: its key, to top up. */
  spent?: string;
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

function poolCovers(b: SharedBudget, act: string, res: string, agent?: string): boolean {
  const s = b.scope ?? {};
  if (s.act !== undefined && !matchAct(s.act, act)) return false;
  if (s.res !== undefined && !matchRes(s.res, res)) return false;
  if (s.agent !== undefined && (agent === undefined || !matchAct(s.agent, agent))) return false;
  return true;
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
    const v: LayerVerdict = { layer: layer.name, verdict: fits ? "allow" : "ask", rule: best, why: fits ? why : `${why}, but its limit is used up` };
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
      return `Asks you (${v.layer}: ${v.why}).`;
    default:
      return `Allowed: your rules let the agent ${verb} this.`;
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
  const cost = ctx.cost ?? riskCost(act, [res]);
  const pools = (policy.budgets ?? []).filter((b) => (b.until === undefined || now < b.until) && poolCovers(b, act, res, ctx.agent));
  const tallies = pools.filter((b) => b.counts === "all").map((b) => ({ key: `budget:${b.id}`, cost }));
  const none = { charges: [], when: [], tallies };
  if (voting.length === 0) return { verdict: "deny", reason: "Refused: no layer has a rule for this.", layers, caps, ...none };
  const deny = voting.find((v) => v.verdict === "deny");
  if (deny) return { verdict: "deny", reason: sentence(deny, act), decidedBy: deny.layer, layers, caps, ...none };
  const ask = voting.find((v) => v.verdict === "ask");
  if (ask) {
    const spent = ask.spent && ask.rule ? { spent: ask.rule.id } : {};
    return { verdict: "ask", reason: sentence(ask, act), decidedBy: ask.layer, layers, caps, ...none, ...spent };
  }
  // Every layer said yes; a shared pool that can't cover this use still turns it into a question.
  const dry = pools.find((b) => !budgetLeft({ id: `budget:${b.id}`, effect: "allow", act, budget: b }, ctx.usage, cost).fits);
  if (dry) {
    return { verdict: "ask", reason: `Asks you: the limit “${dry.note ?? dry.id}” is used up.`, decidedBy: `budget:${dry.id}`, layers, caps, ...none, spent: `budget:${dry.id}` };
  }
  const charges = [
    ...voting.filter((v) => v.rule).map((v) => ({ key: v.rule!.id, cost })),
    ...pools.map((b) => ({ key: `budget:${b.id}`, cost })),
  ];
  const when = voting.flatMap((v) => v.rule?.when ?? []);
  return { verdict: "allow", reason: sentence(voting[0]!, act), layers, caps, charges, when, tallies };
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
  if (worst.verdict !== "allow") return { ...worst, caps, tallies: [...new Map(all.flatMap((d) => d.tallies).map((ch) => [ch.key, ch])).values()] };
  // One grant covers every resource, so it draws once from each rule, and carries every condition any rule asks for.
  const byKey = (cs: Charge[]) => [...new Map(cs.map((ch) => [ch.key, ch])).values()];
  const when = [...new Map(all.flatMap((d) => d.when).map((w) => [`${w.c}=${w.v}`, w])).values()];
  return { ...worst, caps, charges: byKey(all.flatMap((d) => d.charges)), tallies: byKey(all.flatMap((d) => d.tallies)), when };
}

export interface LintWarning {
  layer: string;
  rule: string;
  message: string;
}

/** Explains a policy: rules a layer above makes ineffective, and rules that match nothing or have ended. */
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

/** Problems with a rule written directly (from an editor, not from words). Empty when it's usable. */
export function checkRule(r: unknown): string[] {
  if (!r || typeof r !== "object") return ["not a rule"];
  const x = r as Partial<Rule>;
  const out: string[] = [];
  if (typeof x.id !== "string" || !x.id) out.push("id is missing");
  if (x.effect !== "allow" && x.effect !== "ask" && x.effect !== "deny") out.push("effect must be allow, ask or deny");
  if (typeof x.act !== "string" || !Object.keys(CATALOG).some((a) => matchAct(x.act!, a))) out.push(`"${String(x.act)}" matches no known action`);
  for (const k of ["res", "agent", "note"] as const) if (x[k] !== undefined && typeof x[k] !== "string") out.push(`${k} must be text`);
  for (const k of ["maxTtl", "maxUses", "from", "until"] as const) if (x[k] !== undefined && !(Number.isInteger(x[k]) && x[k]! >= 0)) out.push(`${k} must be a whole number`);
  if (x.budget !== undefined) {
    for (const k of ["uses", "risk"] as const) if (x.budget[k] !== undefined && !(Number.isInteger(x.budget[k]) && x.budget[k]! >= 0)) out.push(`budget.${k} must be a whole number`);
  }
  if (x.when !== undefined && (!Array.isArray(x.when) || x.when.some((c) => !c || typeof c.c !== "string"))) out.push("when must be a list of conditions");
  return out;
}

/** Problems with a shared budget written directly. Empty when it's usable. */
export function checkBudget(b: unknown): string[] {
  if (!b || typeof b !== "object") return ["not a budget"];
  const x = b as Partial<SharedBudget>;
  const out: string[] = [];
  if (typeof x.id !== "string" || !x.id) out.push("id is missing");
  if (x.uses === undefined && x.risk === undefined) out.push("give it a number of uses, an amount of risk, or both");
  for (const k of ["uses", "risk", "until"] as const) if (x[k] !== undefined && !(Number.isInteger(x[k]) && x[k]! >= 0)) out.push(`${k} must be a whole number`);
  if (x.counts !== undefined && x.counts !== "auto" && x.counts !== "all") out.push("counts must be auto or all");
  if (x.scope !== undefined) {
    if (typeof x.scope !== "object" || !x.scope) out.push("scope must be an object");
    else for (const k of ["act", "res", "agent"] as const) if (x.scope[k] !== undefined && typeof x.scope[k] !== "string") out.push(`scope.${k} must be text`);
  }
  return out;
}
