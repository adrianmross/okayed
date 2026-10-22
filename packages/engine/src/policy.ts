import { CATALOG } from "./catalog.ts";
import { matchAct, matchRes } from "./resource.ts";
import type { Effect, Layer, Policy, Rule, Unix } from "./types.ts";

export interface LayerVerdict {
  layer: string;
  verdict: Effect | "abstain";
  /** The rule that decided, or undefined when the layer's default did. */
  rule?: Rule;
  why: string;
}

export interface Decision {
  verdict: Effect;
  /** One sentence naming the first layer that refused or asked, or why it was allowed. */
  reason: string;
  /** The first layer whose verdict is the final one (deny, or the first ask). */
  decidedBy?: string;
  layers: LayerVerdict[];
  /** Tightest caps across the deciding rules of every layer. */
  caps: { ttl?: number; uses?: number };
}

const STRICT: Record<Effect, number> = { allow: 0, ask: 1, deny: 2 };

function literal(p: string | undefined): number {
  return p === undefined ? 0 : p.replace(/\*/g, "").length;
}

/** Specificity: literal characters in the action pattern weigh more than in the resource pattern. */
export function specificity(rule: Rule): number {
  return literal(rule.act) * 1000 + literal(rule.res);
}

export function ruleApplies(rule: Rule, act: string, res: string, now: Unix): boolean {
  if (rule.until !== undefined && now >= rule.until) return false;
  return matchAct(rule.act, act) && matchRes(rule.res, res);
}

/** The verdict of one layer: the most specific matching rule; on a tie, the strictest. */
export function decideLayer(layer: Layer, act: string, res: string, now: Unix): LayerVerdict {
  let best: Rule | undefined;
  for (const rule of layer.rules) {
    if (!ruleApplies(rule, act, res, now)) continue;
    if (
      !best ||
      specificity(rule) > specificity(best) ||
      (specificity(rule) === specificity(best) && STRICT[rule.effect] > STRICT[best.effect])
    ) {
      best = rule;
    }
  }
  if (best) {
    return { layer: layer.name, verdict: best.effect, rule: best, why: best.note ?? `rule "${best.id}" says ${best.effect}` };
  }
  if (layer.default === "abstain") return { layer: layer.name, verdict: "abstain", why: "no rule here; leaves it to the layer above" };
  return {
    layer: layer.name,
    verdict: layer.default,
    why: layer.default === "deny" ? `nothing here covers ${act}` : `no rule here, so ${layer.default}`,
  };
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
export function decide(policy: Policy, act: string, res: string, now: Unix): Decision {
  const layers = policy.layers.map((l) => decideLayer(l, act, res, now));
  const caps: Decision["caps"] = {};
  for (const v of layers) {
    if (v.verdict === "abstain" || !v.rule) continue;
    if (v.rule.maxTtl !== undefined) caps.ttl = Math.min(caps.ttl ?? Infinity, v.rule.maxTtl);
    if (v.rule.maxUses !== undefined) caps.uses = Math.min(caps.uses ?? Infinity, v.rule.maxUses);
  }
  const voting = layers.filter((v) => v.verdict !== "abstain");
  if (voting.length === 0) {
    return { verdict: "deny", reason: "Refused: no layer has a rule for this.", layers, caps };
  }
  const deny = voting.find((v) => v.verdict === "deny");
  if (deny) return { verdict: "deny", reason: sentence(deny, act), decidedBy: deny.layer, layers, caps };
  const ask = voting.find((v) => v.verdict === "ask");
  if (ask) return { verdict: "ask", reason: sentence(ask, act), decidedBy: ask.layer, layers, caps };
  return { verdict: "allow", reason: sentence(voting[0]!, act), layers, caps };
}

/** Decides an action over several resources: the strictest per-resource verdict wins. */
export function decideAll(policy: Policy, act: string, res: string[], now: Unix): Decision {
  const all = res.map((r) => decide(policy, act, r, now));
  let worst = all[0] ?? decide(policy, act, "", now);
  for (const d of all) if (STRICT[d.verdict] > STRICT[worst.verdict]) worst = d;
  const caps: Decision["caps"] = {};
  for (const d of all) {
    if (d.caps.ttl !== undefined) caps.ttl = Math.min(caps.ttl ?? Infinity, d.caps.ttl);
    if (d.caps.uses !== undefined) caps.uses = Math.min(caps.uses ?? Infinity, d.caps.uses);
  }
  return { ...worst, caps };
}

export interface LintWarning {
  layer: string;
  rule: string;
  message: string;
}

/**
 * Flags rules that cannot take effect because a layer above is stricter for every action they name,
 * and rules that are malformed. Narrowing is enforced by `decide` regardless; this explains it.
 */
export function lint(policy: Policy, now: Unix): LintWarning[] {
  const out: LintWarning[] = [];
  policy.layers.forEach((layer, i) => {
    for (const rule of layer.rules) {
      const acts = Object.keys(CATALOG).filter((a) => matchAct(rule.act, a));
      if (acts.length === 0) {
        out.push({ layer: layer.name, rule: rule.id, message: `"${rule.act}" matches no known action` });
        continue;
      }
      if (rule.until !== undefined && rule.until <= now) {
        out.push({ layer: layer.name, rule: rule.id, message: "has expired and no longer applies" });
      }
      if (i === 0 || rule.effect === "deny") continue;
      const above: Policy = { layers: policy.layers.slice(0, i) };
      const blocked = acts.filter((a) => {
        const sample = rule.res && !rule.res.includes("*") ? rule.res : undefined;
        const d = sample ? decide(above, a, sample, now) : decideIgnoringRes(above, a, now);
        return STRICT[d.verdict] > STRICT[rule.effect];
      });
      if (blocked.length === acts.length) {
        const d = decideIgnoringRes(above, acts[0]!, now);
        out.push({
          layer: layer.name,
          rule: rule.id,
          message: `${rule.effect}s ${rule.act}, but ${d.decidedBy ?? "a layer above"} ${d.verdict === "deny" ? "denies" : "asks"}; a layer can only narrow the one above, so this has no effect`,
        });
      }
    }
  });
  return out;
}

function decideIgnoringRes(policy: Policy, act: string, now: Unix): Decision {
  const stripped: Policy = {
    layers: policy.layers.map((l) => ({ ...l, rules: l.rules.filter((r) => r.res === undefined || r.res === "**") })),
  };
  return decide(stripped, act, "", now);
}
