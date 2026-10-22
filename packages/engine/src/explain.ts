import { CATALOG } from "./catalog.ts";
import type { NarrowResult } from "./narrow.ts";
import { labelRes, parseRes } from "./resource.ts";
import type { Beyond, GrantDraft, Request, Rule, Unix } from "./types.ts";

/**
 * Deterministic wording for cards. The model may add a friendlier sentence, but these lines are what the
 * person confirms, so they come from the grant itself.
 */

function agent(aud: string): string {
  return aud.replace(/^agent:/, "");
}

export function duration(s: number): string {
  if (s < 90) return `${s} seconds`;
  if (s < 3600) return `${Math.round(s / 60)} minutes`;
  if (s < 2 * 86400) {
    const h = Math.round(s / 360) / 10;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  return `${Math.round(s / 86400)} days`;
}

function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `up to ${n} times`;
}

/** "Lets assistant merge PR #182 in adrianmross/okayed at 3f9a1c2, once, within the next 15 minutes." */
export function sentenceFor(d: GrantDraft): string {
  const verb = CATALOG[d.act]?.verb ?? d.act;
  const what = d.res.map(labelRes).join(" and ");
  const cond = d.when.some((c) => c.c === "checks.pass") ? ", only if its checks pass" : "";
  return `Lets ${agent(d.aud)} ${verb} ${what}${cond}, ${times(d.uses)}, within the next ${duration(d.exp - d.nbf)}.`;
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
  out.push(`use after ${duration(d.exp - now)} from now`);
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

export function describeRule(r: Rule, now: Unix): string {
  const verb = r.effect === "allow" ? "Auto-approve" : r.effect === "ask" ? "Ask before" : "Never allow";
  const acts = r.act === "*" ? "anything" : r.act.endsWith("*") ? `anything under ${r.act.replace(/\.?\*$/, "")}` : CATALOG[r.act]?.noun ?? r.act;
  const where = r.res && r.res !== "**" ? ` on ${r.res}` : "";
  const until = r.until ? (r.until > now ? ` for ${duration(r.until - now)}` : " (expired)") : "";
  return `${verb} ${acts}${where}${until}`;
}
