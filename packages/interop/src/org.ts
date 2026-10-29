import { checkRule, type Effect, type Layer, type Rule } from "@okayed/engine";
import type { Principal } from "./principal.ts";

/**
 * An organization's policy: what its groups may have their agents do, in okayed's terms. Each person's okayed gets
 * the part that applies to them as a layer above their own rules, so it can only narrow what they allow: the
 * organization says what's possible, and the person still okays each thing (or makes rules for it) inside that.
 */
export interface OrgPolicy {
  /** Who people see on refusals: "Refused by Acme: …". */
  name: string;
  /** Anything no grant covers: blocked (`deny`), or left to the person (`abstain`). */
  default: "deny" | "abstain";
  grants: OrgGrant[];
}

export interface OrgGrant {
  /** A group (`release-managers`), a role (`role:admin`), or `*` for everyone in the organization. */
  to: string;
  /** `allow` leaves it to the person; `ask` always needs their okay, even under their rules; `deny` blocks it. */
  effect: Effect;
  act: string;
  res?: string;
  /** Only for some agents: `agent:ci`, or a group of agents, `group:deployers`. */
  agent?: string;
  /** Longest life and most uses of any one permission. */
  maxTtl?: number;
  maxUses?: number;
  note?: string;
}

/** The names a principal answers to in an organization's policy: its groups, and its roles as `role:<name>`. */
export function memberships(p: Pick<Principal, "groups" | "roles">): Set<string> {
  return new Set([...p.groups.map((g) => g.toLowerCase()), ...p.roles.map((r) => `role:${r.toLowerCase()}`)]);
}

function toRule(g: OrgGrant, i: number): Rule {
  const { to: _to, ...rest } = g;
  return { id: `org:${i + 1}`, ...rest };
}

/**
 * The limits an organization sets on one of its people: their layer of its policy. Someone no longer active gets a
 * layer that blocks everything, so nothing new can be issued for them even before their okayed is stopped.
 */
export function ceilingFor(p: Pick<Principal, "groups" | "roles" | "active">, org: OrgPolicy): Layer {
  if (!p.active) return { name: org.name, default: "deny", rules: [{ id: "org:inactive", effect: "deny", act: "*", note: `you're no longer active at ${org.name}` }] };
  const mine = memberships(p);
  return { name: org.name, default: org.default, rules: org.grants.flatMap((g, i) => (g.to === "*" || mine.has(g.to.toLowerCase()) ? [toRule(g, i)] : [])) };
}

/** Everything wrong with an organization's policy. Empty when it can be used. */
export function checkOrgPolicy(x: unknown): string[] {
  if (!x || typeof x !== "object") return ["an organization's policy must be an object"];
  const o = x as Partial<OrgPolicy>;
  const out: string[] = [];
  if (typeof o.name !== "string" || !o.name.trim()) out.push("needs a name, e.g. Acme");
  if (o.default !== "deny" && o.default !== "abstain") out.push("default must be deny or abstain");
  if (!Array.isArray(o.grants)) return [...out, "grants must be a list"];
  o.grants.forEach((g, i) => {
    if (!g || typeof g.to !== "string" || !g.to.trim()) out.push(`grant ${i + 1}: needs to (a group, role:<name>, or *)`);
    else for (const p of checkRule(toRule(g, i))) out.push(`grant ${i + 1}: ${p}`);
  });
  return out;
}

/** An organization's policy from configuration (JSON), checked. Throws with every problem. */
export function readOrgPolicy(json: string | undefined | null): OrgPolicy | null {
  if (!json?.trim()) return null;
  let x: unknown;
  try {
    x = JSON.parse(json);
  } catch {
    throw new Error("the organization's policy isn't valid JSON");
  }
  const problems = checkOrgPolicy(x);
  if (problems.length) throw new Error(`the organization's policy can't be used: ${problems.join("; ")}`);
  return x as OrgPolicy;
}
