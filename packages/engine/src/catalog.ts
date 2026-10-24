import { parseRes, type Resource } from "./resource.ts";
import type { Layer, Policy, Risk, Rule } from "./types.ts";

export interface ActionSpec {
  act: string;
  /** Resource kinds this action applies to. */
  res: Resource["kind"][];
  risk: Risk;
  readOnly: boolean;
  /** Default and maximum lifetime, seconds. */
  ttl: number;
  maxTtl: number;
  uses: number;
  maxUses: number;
  /** Verb phrase for sentences: "merge", "deploy". */
  verb: string;
  /** Noun phrase for rules: "merging pull requests". */
  noun: string;
  /** Whether a PR resource must pin a commit. */
  pinCommit?: boolean;
}

const MIN = 60;
const HOUR = 3600;

export const CATALOG: Record<string, ActionSpec> = {
  "github.read": {
    act: "github.read",
    res: ["github.repo", "github.pr"],
    risk: "low",
    readOnly: true,
    ttl: HOUR,
    maxTtl: 8 * HOUR,
    uses: 50,
    maxUses: 500,
    verb: "read",
    noun: "reading GitHub",
  },
  "github.pr.comment": {
    act: "github.pr.comment",
    res: ["github.pr"],
    risk: "medium",
    readOnly: false,
    ttl: 30 * MIN,
    maxTtl: 2 * HOUR,
    uses: 1,
    maxUses: 10,
    verb: "comment on",
    noun: "commenting on pull requests",
  },
  "github.pr.merge": {
    act: "github.pr.merge",
    res: ["github.pr"],
    risk: "high",
    readOnly: false,
    ttl: 15 * MIN,
    maxTtl: HOUR,
    uses: 1,
    maxUses: 1,
    verb: "merge",
    noun: "merging pull requests",
    pinCommit: true,
  },
  "site.deploy": {
    act: "site.deploy",
    res: ["site"],
    risk: "medium",
    readOnly: false,
    ttl: 30 * MIN,
    maxTtl: 2 * HOUR,
    uses: 1,
    maxUses: 5,
    verb: "deploy",
    noun: "deploying sites",
  },
  "spend.money": {
    act: "spend.money",
    res: ["money"],
    risk: "critical",
    readOnly: false,
    ttl: 10 * MIN,
    maxTtl: 30 * MIN,
    uses: 1,
    maxUses: 1,
    verb: "spend",
    noun: "spending money",
  },
};

const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function maxRisk(a: Risk, b: Risk): Risk {
  return RANK[a] >= RANK[b] ? a : b;
}

export function riskAtLeast(r: Risk, floor: Risk): boolean {
  return RANK[r] >= RANK[floor];
}

/** Risk of doing `act` on all of `res`. Production deploys are high. */
export function riskOf(act: string, res: string[]): Risk {
  const spec = CATALOG[act];
  if (!spec) return "critical";
  let risk = spec.risk;
  for (const s of res) {
    const r = parseRes(s);
    if (r?.kind === "site" && r.env === "production") risk = maxRisk(risk, "high");
  }
  return risk;
}

/** True if `res` is a well-formed exact resource of a kind `act` applies to. */
export function fitsAction(act: string, res: string): boolean {
  const spec = CATALOG[act];
  const r = parseRes(res);
  if (!spec || !r || !spec.res.includes(r.kind)) return false;
  if (spec.pinCommit && r.kind === "github.pr" && !r.sha) return false;
  return true;
}

/** What one use of an action costs against a risk budget, by its risk. */
export const RISK_COST: Record<Risk, number> = { low: 1, medium: 3, high: 8, critical: 20 };

export function riskCost(act: string, res: string[]): number {
  return RISK_COST[riskOf(act, res)];
}

/**
 * The starting posture ("balanced"): reads and comments go ahead, merges go ahead when checks pass and staging
 * deploys go ahead, each within a budget; production deploys and spending ask. These are ordinary rules in the
 * person's own layer, so they can change or delete any of them.
 */
export const DEFAULT_POSTURE: Rule[] = [
  { id: "posture:read", effect: "allow", act: "github.read", note: "reading GitHub goes ahead" },
  { id: "posture:comment", effect: "allow", act: "github.pr.comment", budget: { uses: 20 }, note: "up to 20 comments, then ask" },
  { id: "posture:merge", effect: "allow", act: "github.pr.merge", when: [{ c: "checks.pass" }], budget: { risk: 40 }, note: "merges go ahead when checks pass, within a budget" },
  { id: "posture:staging", effect: "allow", act: "site.deploy", res: "site:*/staging", budget: { risk: 30 }, note: "staging deploys go ahead, within a budget" },
  { id: "posture:preview", effect: "allow", act: "site.deploy", res: "site:*/preview", budget: { risk: 30 }, note: "preview deploys go ahead, within a budget" },
  { id: "posture:production", effect: "ask", act: "site.deploy", res: "site:*/production", note: "production deploys ask you" },
  { id: "posture:spend", effect: "ask", act: "spend.money", note: "spending money asks you" },
];

/** The person's layer. With nothing matching, it asks. */
export const YOU = "you";

export function personalLayer(rules: Rule[] = DEFAULT_POSTURE): Layer {
  return { name: YOU, default: "ask", rules: rules.map((r) => ({ ...r })) };
}

/** A new person's policy: their own layer with the default posture. An organization may add a ceiling above it. */
export function defaultPolicy(): Policy {
  return { layers: [personalLayer()] };
}
