/** Unix time in seconds. The engine never reads a clock; callers pass `now`. */
export type Unix = number;

export type Risk = "low" | "medium" | "high" | "critical";
export type Effect = "allow" | "ask" | "deny";

export interface Condition {
  c: string;
  v?: string | number;
}

export interface Rule {
  id: string;
  effect: Effect;
  /** Action pattern: `*` matches any run of characters, e.g. `github.*`. */
  act: string;
  /** Resource pattern: `*` matches one segment, `**` the rest. Omitted means any. */
  res?: string;
  maxTtl?: number;
  maxUses?: number;
  /** The rule stops applying at this time. */
  until?: Unix;
  note?: string;
}

export interface Layer {
  name: string;
  /** What the layer says when none of its rules match. The top layer should deny. */
  default: Effect | "abstain";
  rules: Rule[];
}

export interface Policy {
  layers: Layer[];
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
