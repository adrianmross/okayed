import { canonRes } from "./resource.ts";
import type { Condition, Risk, Unix } from "./types.ts";

/** The parts of a grant a use is checked against. */
export interface GrantBody {
  v: number;
  id: string;
  aud: string;
  act: string;
  res: string[];
  when: Condition[];
  nbf: Unix;
  exp: Unix;
  uses: number;
  risk: Risk;
}

export interface Use {
  aud: string;
  act: string;
  res: string;
  now: Unix;
}

export interface UseState {
  revoked: boolean;
  used: number;
  /** Time of the latest emergency stop, if any. */
  stoppedAt?: Unix;
  /** When the grant was issued; a stop at or after this revokes it. */
  issuedAt: Unix;
}

/** Facts a verifier looked up for conditions, e.g. `{ "checks.pass": true }`. Missing means unknown. */
export type Facts = Partial<Record<string, boolean>>;

export type UseCode =
  | "bad_version"
  | "not_yet"
  | "expired"
  | "wrong_audience"
  | "wrong_action"
  | "wrong_resource"
  | "condition_unknown"
  | "condition_failed"
  | "revoked"
  | "stopped"
  | "used_up";

export type UseCheck = { ok: true; left: number } | { ok: false; code: UseCode; reason: string };

/**
 * Checks one use of a grant: version, time window, audience, exact action and resource, conditions,
 * revocation, emergency stop and remaining uses. Pure; signature and id checks live in @okayed/grant.
 */
export function checkUse(g: GrantBody, use: Use, state: UseState, facts: Facts = {}): UseCheck {
  const no = (code: UseCode, reason: string): UseCheck => ({ ok: false, code, reason });
  if (g.v !== 0) return no("bad_version", `grant format v${g.v} is not supported`);
  if (use.now < g.nbf) return no("not_yet", "the grant is not valid yet");
  if (use.now >= g.exp) return no("expired", "the grant has expired");
  if (use.aud !== g.aud) return no("wrong_audience", `the grant is for ${g.aud}, not ${use.aud}`);
  if (use.act !== g.act) return no("wrong_action", `the grant allows ${g.act}, not ${use.act}`);
  const res = canonRes(use.res);
  if (!res || !g.res.includes(res)) return no("wrong_resource", `the grant does not cover ${use.res}`);
  for (const c of g.when) {
    if (c.c === "before") {
      if (typeof c.v !== "number" || use.now >= c.v) return no("condition_failed", "past the grant's cut-off time");
    } else if (c.c === "checks.pass") {
      const f = facts["checks.pass"];
      if (f === undefined) return no("condition_unknown", "could not confirm the checks passed");
      if (!f) return no("condition_failed", "the checks have not passed");
    } else {
      return no("condition_unknown", `unknown condition ${c.c}`);
    }
  }
  if (state.revoked) return no("revoked", "the grant was revoked");
  if (state.stoppedAt !== undefined && state.stoppedAt >= state.issuedAt) return no("stopped", "an emergency stop revoked every grant");
  if (state.used >= g.uses) return no("used_up", g.uses === 1 ? "the grant was for one use and it has been used" : `all ${g.uses} uses are spent`);
  return { ok: true, left: g.uses - state.used - 1 };
}
