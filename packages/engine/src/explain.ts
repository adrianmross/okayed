import { CATALOG } from "./catalog.ts";
import { longDuration } from "./format.ts";
import type { NarrowResult } from "./narrow.ts";
import { isPattern, labelRes, parseRes } from "./resource.ts";
import type { Beyond, GrantDraft, Request, Rule, Unix, Usage } from "./types.ts";

/**
 * Deterministic wording for cards. The model may add a friendlier sentence, but these lines are what the
 * person confirms, so they come from the grant itself.
 */

function agent(aud: string): string {
  return aud.replace(/^agent:/, "");
}

function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `up to ${n} times`;
}

/** "Lets assistant merge PR #182 in adrianmross/okayed at 3f9a1c2, once, within the next 15 minutes." */
export function sentenceFor(d: GrantDraft): string {
  const verb = CATALOG[d.act]?.verb ?? d.act;
  const what = d.res.map(labelRes).join(" and ");
  const cond = d.when.some((c) => c.c === "checks.pass") ? ", only if its checks pass" : "";
  return `Lets ${agent(d.aud)} ${verb} ${what}${cond}, ${times(d.uses)}, within the next ${longDuration(d.exp - d.nbf)}.`;
}

export function allowsFor(d: GrantDraft): string[] {
  const verb = CATALOG[d.act]?.verb ?? d.act;
  return d.res.map((r) => `${verb} ${labelRes(r)}`);
}

/** What the grant does not allow, phrased for the kind of target. */
export function doesNotAllowFor(d: GrantDraft, now: Unix = d.nbf): string[] {
  const out: string[] = [];
  const verb = CATALOG[d.act]?.verb ?? d.act;
  for (const s of d.res) {
    const r = parseRes(s);
    if (!r) continue;
    if (r.kind === "github.pr") {
      out.push(`${verb} any other pull request`);
      if (r.sha) out.push(`${verb} #${r.number} if it changes after ${r.sha.slice(0, 7)}`);
    } else if (r.kind === "github.repo") out.push(`touch any other repository`);
    else if (r.kind === "site") out.push(`${verb} ${r.host} to any environment but ${r.env}, or any other site`);
    else if (r.kind === "money") out.push(`spend more than ${r.max} ${r.currency}`);
  }
  if (d.act !== "github.read") out.push("anything other than this one action");
  else out.push("write, comment, merge or deploy");
  out.push(d.uses === 1 ? "a second use" : `more than ${d.uses} uses`);
  out.push(`use after ${longDuration(d.exp - now)} from now`);
  out.push(`act for anyone but ${agent(d.aud)}`);
  return [...new Set(out)];
}

export function describeRequestSentence(r: Request): string {
  const verb = CATALOG[r.act]?.verb ?? r.act;
  return `${agent(r.aud)} wants to ${verb} ${r.res.map(labelRes).join(" and ")}${r.why ? `: “${r.why}”` : ""}.`;
}

function beyondLine(b: Beyond): string {
  return b.granted ? `${b.asked} → ${b.granted} (${b.why})` : `${b.asked} (${b.why})`;
}

/** "Asked for X, granted Y, refused Z because …" in one line. */
export function summarize(result: NarrowResult): string {
  if (result.kind === "question") return result.question;
  if (result.kind === "refuse") return `Refused: ${result.reason}`;
  const cut = result.beyond.filter((b) => !b.granted);
  const trimmed = result.beyond.filter((b) => b.granted);
  const parts = [`Granted: ${sentenceFor(result.draft)}`];
  if (trimmed.length) parts.push(`Narrowed: ${trimmed.map(beyondLine).join("; ")}.`);
  if (cut.length) parts.push(`Refused: ${cut.map(beyondLine).join("; ")}.`);
  return parts.join(" ");
}

/** A resource pattern the way people read it: "adrianmross/okayed", "staging on any site". */
export function patternLabel(p: string): string {
  if (p === "**" || p === "*") return "anything";
  if (!isPattern(p)) return labelRes(p);
  let m = /^github:([^/*]+)\/([^/*]+)\/\*\*$/.exec(p);
  if (m) return `${m[1]}/${m[2]}`;
  if ((m = /^github:([^/*]+)\/\*\*$/.exec(p))) return `any repo of ${m[1]}`;
  if ((m = /^site:\*\/([^/*]+)$/.exec(p))) return `${m[1]} on any site`;
  if ((m = /^site:([^/*]+)\/\*$/.exec(p))) return `any environment of ${m[1]}`;
  return p;
}

/** A rule's parts, for UIs that show each as a pill. */
export interface RuleParts {
  effect: "Auto-approve" | "Ask before" | "Never allow";
  what: string;
  agent?: string;
  where?: string;
  only?: string;
  /** "3 of 5 left", "24 of 40 risk left". */
  budget?: string;
  /** "for 2 weeks", "from Nov 3", "ended". */
  horizon?: string;
  /** Per-grant caps: "each grant up to 30 minutes". */
  each?: string;
}

function day(t: Unix): string {
  return new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function ruleParts(r: Rule, now: Unix, usage?: Usage): RuleParts {
  const parts: RuleParts = {
    effect: r.effect === "allow" ? "Auto-approve" : r.effect === "ask" ? "Ask before" : "Never allow",
    what: r.act === "*" ? "anything" : r.act.endsWith("*") ? `anything under ${r.act.replace(/\.?\*$/, "")}` : CATALOG[r.act]?.noun ?? r.act,
  };
  if (r.agent) parts.agent = r.agent.replace(/^agent:/, "");
  if (r.res && r.res !== "**") parts.where = patternLabel(r.res);
  if (r.when?.length) parts.only = r.when.map((c) => (c.c === "checks.pass" ? "checks pass" : c.c === "before" && typeof c.v === "number" ? `before ${day(c.v)}` : c.c)).join(" and ");
  if (r.budget) {
    const spent = usage?.[r.id] ?? { uses: 0, risk: 0 };
    const bits: string[] = [];
    if (r.budget.uses !== undefined) bits.push(`${Math.max(0, r.budget.uses - spent.uses)} of ${r.budget.uses} left`);
    if (r.budget.risk !== undefined) bits.push(`${Math.max(0, r.budget.risk - spent.risk)} of ${r.budget.risk} risk left`);
    parts.budget = bits.join(", ");
  }
  if (r.until !== undefined && r.until <= now) parts.horizon = "ended";
  else if (r.from !== undefined && r.from > now) parts.horizon = `from ${day(r.from)}${r.until ? ` to ${day(r.until)}` : ""}`;
  else if (r.until !== undefined) parts.horizon = `for ${longDuration(r.until - now)}`;
  const each = [r.maxTtl !== undefined ? `up to ${longDuration(r.maxTtl)}` : "", r.maxUses !== undefined ? `${r.maxUses === 1 ? "once" : `${r.maxUses} uses`}` : ""].filter(Boolean);
  if (each.length) parts.each = `each grant ${each.join(", ")}`;
  return parts;
}

/** "Auto-approve merging pull requests for assistant in adrianmross/okayed, only if checks pass, 3 of 5 left, for 2 weeks". */
export function describeRule(r: Rule, now: Unix, usage?: Usage): string {
  const p = ruleParts(r, now, usage);
  let s = `${p.effect} ${p.what}`;
  if (p.agent) s += ` for ${p.agent}`;
  if (p.where) s += ` in ${p.where}`;
  const tail = [p.only ? `only if ${p.only}` : "", p.budget ?? "", p.each ?? ""].filter(Boolean);
  if (tail.length) s += `, ${tail.join(", ")}`;
  if (p.horizon) s += p.horizon === "ended" ? " (ended)" : ` ${p.horizon}`;
  return s;
}
