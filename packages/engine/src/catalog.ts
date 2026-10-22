import { parseRes, type Resource } from "./resource.ts";
import type { Layer, Risk } from "./types.ts";

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

/**
 * The built-in top layer: the most any user policy can allow. Reads can be auto-approved;
 * anything that changes the world needs the person; unknown actions are denied.
 */
export const BASELINE: Layer = {
  name: "okayed",
  default: "deny",
  rules: [
    { id: "read", effect: "allow", act: "github.read", note: "reading GitHub can be auto-approved" },
    { id: "comment", effect: "ask", act: "github.pr.comment", note: "comments need your okay" },
    { id: "merge", effect: "ask", act: "github.pr.merge", maxUses: 1, note: "merges always need your okay" },
    { id: "deploy", effect: "ask", act: "site.deploy", note: "deploys always need your okay" },
    { id: "spend", effect: "ask", act: "spend.money", maxUses: 1, note: "spending money always needs your okay" },
  ],
};

/** The person's layer before they've said anything: ask about everything. */
export const DEFAULT_USER_LAYER: Layer = { name: "you", default: "ask", rules: [] };
