import { extractAnchors, type Anchors } from "./anchors.ts";
import { bind, type Base } from "./bind.ts";
import { CATALOG, fitsAction, riskOf, type ActionSpec } from "./catalog.ts";
import { shortDuration, usesLabel } from "./format.ts";
import { decideAll, type Decision } from "./policy.ts";
import { canonRes, isPattern, labelRes, parseRes } from "./resource.ts";
import type { Beyond, Condition, GrantDraft, Policy, Request, Targets, Unix, Usage } from "./types.ts";

/** What the model proposed, coerced from untrusted JSON. Every field is optional and only ever narrows. */
export interface Proposal {
  request?: string;
  act?: string;
  res?: string[];
  ttl?: number;
  uses?: number;
  when?: Condition[];
  aud?: string;
}

export interface NarrowInput {
  utterance: string;
  /** The model's draft. Untrusted: may be missing, malformed or hostile. */
  proposal: unknown;
  requests: Request[];
  targets: Targets;
  policy: Policy;
  now: Unix;
  /** A request picked by an unambiguous gesture (a button), bypassing word matching. */
  select?: string;
  /** What each standing policy has spent, so a spent budget asks instead of allowing. */
  usage?: Usage;
}

export type NarrowResult =
  | {
      kind: "grant";
      draft: GrantDraft;
      /** The proposal as the model wrote it, normalized for display. */
      asked: Proposal;
      beyond: Beyond[];
      decision: Decision;
      notes: string[];
    }
  | { kind: "question"; question: string; options: string[]; beyond: Beyond[] }
  | { kind: "refuse"; reason: string; beyond: Beyond[]; decision?: Decision };

const KNOWN_CONDITIONS = new Set(["checks.pass", "before"]);

function int(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? Math.floor(x) : undefined;
}

/** Turns whatever the model returned into a `Proposal`, dropping anything of the wrong type. */
export function coerceProposal(raw: unknown): Proposal {
  const p: Proposal = {};
  if (!raw || typeof raw !== "object") return p;
  const o = raw as Record<string, unknown>;
  if (typeof o.request === "string") p.request = o.request;
  if (typeof o.act === "string") p.act = o.act.trim();
  else if (Array.isArray(o.act) && typeof o.act[0] === "string") p.act = o.act[0];
  if (typeof o.res === "string") p.res = [o.res];
  else if (Array.isArray(o.res)) p.res = o.res.filter((x): x is string => typeof x === "string");
  const ttl = int(o.ttl);
  if (ttl !== undefined) p.ttl = ttl;
  const uses = int(o.uses);
  if (uses !== undefined) p.uses = uses;
  if (Array.isArray(o.when)) {
    p.when = o.when
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as { c?: unknown }).c === "string")
      .map((c) => {
        const out: Condition = { c: c.c as string };
        if (typeof c.v === "string" || typeof c.v === "number") out.v = c.v;
        return out;
      });
  }
  if (typeof o.aud === "string") p.aud = o.aud;
  return p;
}

/** Who the grant's scope comes from, for "… not this" reasons. */
function sourceOf(base: Base): string {
  return base.request ? "the agent asked" : "you said";
}

/** The draft's targets intersected with the base, exact forms only, minus environments the person excluded. */
function narrowTargets(base: Base, p: Proposal, a: Anchors, beyond: Beyond[], notes: string[]): string[] {
  const said = sourceOf(base);
  const baseRes = base.res.map(canonRes).filter((r): r is string => r !== null && fitsAction(base.act, r));
  if (baseRes.length === 0) return [];
  let res: string[] = [];
  for (const r of p.res ?? []) {
    const c = isPattern(r) ? null : canonRes(r);
    if (isPattern(r)) beyond.push({ field: "res", asked: r, why: "wildcards are never granted; grants name exact targets" });
    else if (!c) beyond.push({ field: "res", asked: r, why: "not a resource okayed can pin exactly" });
    else if (!baseRes.includes(c)) beyond.push({ field: "res", asked: r, why: `${said} ${baseRes.map(labelRes).join(", ")}, not this` });
    else if (!res.includes(c)) res.push(c);
  }
  if (res.length === 0) {
    if (p.res?.length) notes.push(`The draft named no valid target, so the grant uses exactly what ${said}.`);
    res = baseRes;
  }
  return res.filter((r) => {
    const x = parseRes(r);
    const excluded = x?.kind === "site" && a.negatedEnvs.includes(x.env);
    if (excluded) beyond.push({ field: "res", asked: r, why: "you said not this environment" });
    return !excluded;
  });
}

interface Limit {
  /** Where the value starts (what was said, else the catalog default) and why. */
  start: [number, string];
  /** Ceilings, each with the reason it would give. */
  caps: [number, string][];
  /** What the draft asked for; it may lower the value but never raise it. */
  asked?: number;
  /** What the person said, reported if a cap cut it. */
  said?: number;
  /** The smallest draft value that is honored. */
  floor: number;
  field: "ttl" | "uses";
  label: (n: number) => string;
}

/** Lifetimes and use counts work the same way: start from what was said, take the lowest cap, let the draft only lower it. */
function capped(l: Limit, beyond: Beyond[]): number {
  let [value, why] = l.start;
  for (const [cap, capWhy] of l.caps) {
    if (cap < value) [value, why] = [cap, capWhy];
  }
  const draftCut = l.asked !== undefined && l.asked > value;
  if (draftCut) beyond.push({ field: l.field, asked: l.label(l.asked!), granted: l.label(value), why });
  else if (l.asked !== undefined && l.asked >= l.floor) value = l.asked;
  if (l.said !== undefined && l.said > value && !draftCut) beyond.push({ field: l.field, asked: l.label(l.said), granted: l.label(value), why });
  return value;
}

function lifetime(spec: ActionSpec, a: Anchors, p: Proposal, decision: Decision, beyond: Beyond[]): number {
  const caps: [number, string][] = [[spec.maxTtl, `${spec.verb} grants last at most ${shortDuration(spec.maxTtl)}`]];
  if (decision.caps.ttl !== undefined) caps.push([decision.caps.ttl, `your rule caps this at ${shortDuration(decision.caps.ttl)}`]);
  const start: [number, string] = a.ttl !== undefined ? [a.ttl, `you said ${shortDuration(a.ttl)}`] : [spec.ttl, `the shortest reasonable lifetime for ${spec.verb} is ${shortDuration(spec.ttl)}`];
  const ttl = capped({ start, caps, asked: p.ttl, said: a.ttl, floor: 60, field: "ttl", label: shortDuration }, beyond);
  if (a.unbounded) beyond.push({ field: "ttl", asked: "no expiry", granted: shortDuration(ttl), why: "every grant expires" });
  return ttl;
}

function useCount(spec: ActionSpec, a: Anchors, p: Proposal, decision: Decision, beyond: Beyond[]): number {
  const caps: [number, string][] = [[spec.maxUses, `${spec.verb} grants allow at most ${usesLabel(spec.maxUses)}`]];
  if (decision.caps.uses !== undefined) caps.push([decision.caps.uses, `your rule allows ${usesLabel(decision.caps.uses)}`]);
  const start: [number, string] = a.uses !== undefined ? [a.uses, `you said ${usesLabel(a.uses)}`] : [spec.uses, `${spec.verb} grants default to ${usesLabel(spec.uses)}`];
  return capped({ start, caps, asked: p.uses, said: a.uses, floor: 1, field: "uses", label: usesLabel }, beyond);
}

/** The draft's checkable conditions plus any the person stated. Conditions only ever narrow. */
function conditions(act: string, a: Anchors, p: Proposal, now: Unix, beyond: Beyond[]): Condition[] {
  const when: Condition[] = [];
  const add = (c: Condition) => {
    if (!when.some((w) => w.c === c.c && w.v === c.v)) when.push(c);
  };
  for (const c of p.when ?? []) {
    if (!KNOWN_CONDITIONS.has(c.c)) beyond.push({ field: "when", asked: c.c, why: "not a condition verifiers can check" });
    else if (c.c === "checks.pass" && act !== "github.pr.merge") beyond.push({ field: "when", asked: c.c, why: "only applies to merges" });
    else if (c.c === "before" && (typeof c.v !== "number" || c.v <= now)) beyond.push({ field: "when", asked: `before ${c.v}`, why: "not a future time" });
    else add(c);
  }
  for (const c of a.conditions) if (c.c !== "checks.pass" || act === "github.pr.merge") add(c);
  return when;
}

/**
 * Turns a model's proposal into the narrowest grant the person's words and the pending request support, then
 * applies policy. Never returns anything broader than the bound base; reports everything it cut.
 */
export function narrowGrant(input: NarrowInput): NarrowResult {
  const a = extractAnchors(input.select ? "" : input.utterance, input.targets);
  const p = coerceProposal(input.proposal);
  const beyond: Beyond[] = [];
  const notes: string[] = [];

  const bound = bind(
    { requests: input.requests, targets: input.targets, now: input.now, ...(input.select ? { select: input.select } : {}), ...(p.request !== undefined ? { draftRequest: p.request } : {}), ...(p.act ? { draftAct: p.act } : {}) },
    a,
    beyond,
  );
  if (!bound.ok) return "question" in bound ? { kind: "question", question: bound.question, options: bound.options, beyond } : { kind: "refuse", reason: bound.reason, beyond };
  const base = bound.base;
  const spec = CATALOG[base.act];
  if (!spec) return { kind: "refuse", reason: `${base.act} is not an action okayed knows.`, beyond };

  if (p.act !== undefined && p.act !== base.act) {
    beyond.push({ field: "act", asked: p.act, granted: base.act, why: isPattern(p.act) ? "wildcard actions are never granted" : `${sourceOf(base)} ${base.act}, not ${p.act}` });
  }

  if (!base.res.some((r) => canonRes(r) && fitsAction(base.act, canonRes(r)!))) {
    return { kind: "refuse", reason: `The request names no exact target that ${base.act} can apply to.`, beyond };
  }
  let res = narrowTargets(base, p, a, beyond, notes);
  if (res.length === 0) return { kind: "refuse", reason: "Nothing is left once the environments you excluded are removed.", beyond };

  // Policy: drop the targets it denies; the rest are decided together, for this agent, against what's been spent.
  const ctx = { agent: base.aud, ...(input.usage ? { usage: input.usage } : {}) };
  const verdictOn = (rs: string[]) => decideAll(input.policy, base.act, rs, input.now, ctx);
  const denied = res.filter((r) => verdictOn([r]).verdict === "deny");
  for (const r of denied) beyond.push({ field: "res", asked: r, why: verdictOn([r]).reason });
  if (denied.length === res.length) {
    const decision = verdictOn(res);
    return { kind: "refuse", reason: decision.reason, beyond, decision };
  }
  res = res.filter((r) => !denied.includes(r));
  const decision = verdictOn(res);

  const ttl = lifetime(spec, a, p, decision, beyond);
  const uses = useCount(spec, a, p, decision, beyond);
  // Conditions the deciding policies require ride on the grant too ("merges go ahead when checks pass").
  const when = conditions(base.act, a, p, input.now, beyond);
  for (const c of decision.when) if (!when.some((w) => w.c === c.c && w.v === c.v)) when.push(c);
  if (p.aud !== undefined && p.aud !== base.aud) beyond.push({ field: "aud", asked: p.aud, granted: base.aud, why: `${sourceOf(base)} ${base.aud}` });

  const draft: GrantDraft = {
    aud: base.aud,
    act: base.act,
    res,
    when,
    nbf: input.now,
    exp: input.now + ttl,
    uses,
    risk: riskOf(base.act, res),
    from: { utterance: input.utterance, request: base.request?.id ?? null },
  };
  return { kind: "grant", draft, asked: { ...p }, beyond, decision, notes };
}
