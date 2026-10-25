/** Unix time in seconds. The engine never reads a clock; callers pass `now`. */
export type Unix = number;

export type Risk = "low" | "medium" | "high" | "critical";
export type Effect = "allow" | "ask" | "deny";

export interface Condition {
  c: string;
  v?: string | number;
}

/**
 * A standing policy: what an agent may do repeatedly, and within which bounds. Every use under an `allow` rule is
 * still issued as its own exact, once-only grant; the rule only decides whether that grant needs the person.
 */
export interface Rule {
  id: string;
  effect: Effect;
  /** Action pattern: `*` matches any run of characters, e.g. `github.*`. */
  act: string;
  /** Resource pattern: `*` matches one segment, `**` the rest. Omitted means any. */
  res?: string;
  /** Agent pattern, e.g. `agent:assistant`. Omitted means any of the person's agents. */
  agent?: string;
  /** Longest life of each grant issued under this rule, seconds. */
  maxTtl?: number;
  /** Most uses of each grant issued under this rule. */
  maxUses?: number;
  /** The rule applies from this time (inclusive)… */
  from?: Unix;
  /** …until this time (exclusive). Together, its horizon. */
  until?: Unix;
  /** Totals across every grant this rule auto-approves. Once spent, the next one asks the person. */
  budget?: Budget;
  /** Conditions every grant issued under this rule must carry, e.g. `checks.pass`. */
  when?: Condition[];
  note?: string;
}

export interface Budget {
  /** How many grants it may auto-approve in all. */
  uses?: number;
  /** How much risk it may spend in all; each action costs `riskCost` of its risk. */
  risk?: number;
}

/** What each rule (by id) and shared budget (by `budget:<id>`) has spent. Kept by the caller; the engine only reads it. */
export type Usage = Record<string, { uses: number; risk: number }>;

export interface Layer {
  name: string;
  /** What the layer says when none of its rules match. The top layer should deny. */
  default: Effect | "abstain";
  rules: Rule[];
}

export interface Policy {
  layers: Layer[];
  /** Shared budgets: pools that span every policy matching their scope. None by default. */
  budgets?: SharedBudget[];
}

/**
 * A budget shared across policies. With no scope it is global; with `act: "github.pr.merge"` it covers every merge;
 * with an agent, everything that agent does. Draws count auto-approvals, or with `counts: "all"` your own okays too.
 */
export interface SharedBudget extends Budget {
  id: string;
  scope?: { act?: string; res?: string; agent?: string };
  counts?: "auto" | "all";
  /** The pool stops applying at this time; a fresh one can replace it. */
  until?: Unix;
  note?: string;
}

/** What an agent asked for. */
export interface Request {
  id: string;
  aud: string;
  act: string;
  res: string[];
  why: string;
  at: Unix;
  exp: Unix;
}

/** What the caller knows about the person's world, used to bind words to exact targets. */
export interface Targets {
  /** `owner/repo`, lowercase. */
  repos: string[];
  prs: { repo: string; number: number; head?: string }[];
  sites: { host: string; envs: string[] }[];
  agents: string[];
}

export interface GrantDraft {
  aud: string;
  act: string;
  res: string[];
  when: Condition[];
  nbf: Unix;
  exp: Unix;
  uses: number;
  risk: Risk;
  from: { utterance: string; request: string | null };
}

/** One thing that was asked for and not granted, with the reason. */
export interface Beyond {
  field: "request" | "act" | "res" | "ttl" | "uses" | "when" | "aud" | "effect" | "until";
  asked: string;
  granted?: string;
  why: string;
}

export const EMPTY_TARGETS: Targets = { repos: [], prs: [], sites: [], agents: [] };
