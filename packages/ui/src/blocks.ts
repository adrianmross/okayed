import { CATALOG, humanDuration, labelRes, parseRes, ruleParts, type Beyond, type Decision, type GrantDraft, type Rule, type Usage } from "@okayed/engine";
import { h } from "./dom.ts";

/** Kinds of fact a block can hold; each has its own tile tone in style.css. */
export type Tone = "who" | "what" | "time" | "cond" | "allow" | "ask" | "deny" | "cut";

export function block(tone: Tone, ...line: (Node | string | null)[]): HTMLElement {
  return h("div", { class: `block ${tone}` }, h("span", { class: "tile", "aria-hidden": "true" }), h("div", { class: "line" }, line));
}

export function pill(text: string, extra = ""): HTMLElement {
  return h("span", { class: `pill ${extra}`.trim() }, text);
}

function agentName(aud: string): string {
  return aud.replace(/^agent:/, "");
}

function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

/** A grant as four short sentences: who, does what to what, how often and how long, only if. */
export function grantBlocks(d: GrantDraft): HTMLElement {
  const verb = CATALOG[d.act]?.verb ?? d.act;
  const targets = d.res.flatMap((r, i) => [i ? " and " : "", pill(labelRes(r))]);
  return h(
    "div",
    { class: "blocks" },
    block("who", pill(agentName(d.aud)), " may"),
    block("what", pill(verb), " ", ...targets),
    block("time", pill(times(d.uses)), ", within ", pill(humanDuration(d.exp - d.nbf))),
    d.when.length ? block("cond", "only if ", ...d.when.map((c) => pill(c.c === "checks.pass" ? "its checks pass" : `${c.c}${c.v !== undefined ? ` ${c.v}` : ""}`))) : null,
  );
}

const FIELD: Record<Beyond["field"], string> = {
  request: "request",
  act: "action",
  res: "target",
  ttl: "lifetime",
  uses: "uses",
  when: "condition",
  aud: "agent",
  effect: "effect",
  until: "lasts",
};

/** Shows a value the way people read it: "PR #7 in adrianmross/matrix" rather than the full resource URI. */
function readable(value: string): string {
  return parseRes(value) ? labelRes(value) : value;
}

/** Everything the engine cut from the draft, as one block: the struck value, what replaced it, and why. */
export function cutBlocks(beyond: Beyond[]): HTMLElement | null {
  if (!beyond.length) return null;
  return block(
    "cut",
    h("strong", null, beyond.length === 1 ? "Cut from the draft" : `${beyond.length} things cut from the draft`),
    h(
      "div",
      { class: "cuts" },
      beyond.map((b) =>
        h(
          "div",
          null,
          h("span", { class: "why" }, `${FIELD[b.field]} `),
          pill(readable(b.asked), "gone"),
          ...(b.granted ? [" → ", pill(readable(b.granted))] : []),
          h("span", { class: "why" }, ` ${b.why}`),
        ),
      ),
    ),
  );
}

export interface RuleActions {
  /** Called with the edited rule; omit to show the rule read-only. */
  change?: (next: Rule) => void;
  remove?: () => void;
  topUp?: () => void;
}

const HORIZONS: [string, number | null][] = [["no end", null], ["for 1 day", 86400], ["for 1 week", 7 * 86400], ["for 30 days", 30 * 86400]];
const COUNTS: [string, number | null][] = [["no limit", null], ["1 time", 1], ["5 times", 5], ["10 times", 10], ["30 times", 30]];

function pickPill(label: string, current: string, options: [string, string][], onPick: (v: string) => void): HTMLElement {
  const opts = options.some(([v]) => v === current) ? options : [[current, current] as [string, string], ...options];
  return h(
    "select",
    { class: "pill", "aria-label": label, onchange: (e: Event) => onPick((e.target as HTMLSelectElement).value) },
    opts.map(([v, text]) => h("option", { value: v, selected: v === current }, text)),
  );
}

/**
 * A standing policy as one block: its effect, what, for whom, where, only-if, budget left and horizon, each a pill.
 * With `change`, the effect, horizon and count are pills you can set.
 */
export function ruleBlock(rule: Rule, now: number, usage?: Usage, act: RuleActions = {}): HTMLElement {
  const p = ruleParts(rule, now, usage);
  const edit = act.change;
  const spent = rule.budget && Object.values(budgetLeftOf(rule, usage)).some((left) => left <= 0);
  const line: (Node | string | null)[] = [];
  line.push(edit ? pickPill("Effect", rule.effect, [["allow", "Auto-approve"], ["ask", "Ask before"], ["deny", "Never allow"]], (v) => edit({ ...rule, effect: v as Rule["effect"] })) : pill(p.effect), " ", pill(p.what));
  if (p.agent) line.push(" for ", pill(p.agent));
  if (p.where) line.push(" in ", pill(p.where));
  if (p.only) line.push(" only if ", pill(p.only));
  if (rule.effect === "allow") {
    if (edit) {
      const count = rule.budget?.uses !== undefined ? `${rule.budget.uses}` : "";
      const counts: [string, string][] = COUNTS.map(([t, n]) => [n === null ? "" : String(n), t]);
      if (count && !counts.some(([v]) => v === count)) counts.splice(1, 0, [count, `${count} times`]);
      // A risk budget already bounds the count, so only offer a count where it would be the bound.
      if (rule.budget?.risk === undefined) line.push(" · ", pickPill("Count", count, counts, (v) => {
        const budget = { ...rule.budget };
        if (v) budget.uses = Number(v);
        else delete budget.uses;
        const next: Rule = { ...rule, budget };
        if (budget.uses === undefined && budget.risk === undefined) delete next.budget;
        edit(next);
      }));
      const end = rule.until === undefined ? "" : String(Math.max(0, rule.until - now));
      const lasts: [string, string][] = HORIZONS.map(([t, n]) => [n === null ? "" : String(n), t]);
      if (end && !lasts.some(([v]) => v === end)) lasts.unshift([end, p.horizon ?? end]);
      line.push(" ", pickPill("Lasts", end, lasts, (v) => {
        const next: Rule = { ...rule };
        if (v) next.until = now + Number(v);
        else delete next.until;
        edit(next);
      }));
    } else if (p.horizon) line.push(" ", pill(p.horizon));
    if (p.budget) line.push(" · ", pill(p.budget, spent ? "gone" : ""));
  } else if (p.horizon) line.push(" ", pill(p.horizon));
  if (rule.note && !edit) line.push(h("div", { class: "why" }, rule.note));
  const b = block(spent ? "cut" : rule.effect, ...line);
  if (spent && act.topUp) b.append(h("button", { class: "btn", type: "button", onclick: act.topUp }, "Top up"));
  if (act.remove) b.append(h("button", { class: "x", type: "button", "aria-label": "Remove rule", onclick: act.remove }, "×"));
  return b;
}

function budgetLeftOf(rule: Rule, usage?: Usage): Record<string, number> {
  const spent = usage?.[rule.id] ?? { uses: 0, risk: 0 };
  const out: Record<string, number> = {};
  if (rule.budget?.uses !== undefined) out.uses = rule.budget.uses - spent.uses;
  if (rule.budget?.risk !== undefined) out.risk = rule.budget.risk - spent.risk;
  return out;
}

export const VERDICT_WORD: Record<Decision["verdict"], string> = { allow: "Yes", ask: "Asks you first", deny: "No" };

export function layersTable(d: Pick<Decision, "layers"> | { layers: { layer: string; verdict: string; why: string }[] }): HTMLElement {
  return h(
    "table",
    { class: "layers" },
    d.layers.map((l) => h("tr", null, h("td", null, l.layer), h("td", null, h("span", { class: `badge ${l.verdict}` }, l.verdict)), h("td", null, l.why))),
  );
}

/** The one-word answer, its reason, and on a yes what it draws from which budget. Layers are Debug-only. */
export function verdictView(d: Decision): HTMLElement {
  const draws = d.verdict === "allow" ? d.layers.filter((l) => l.rule?.budget) : [];
  return h(
    "div",
    null,
    h("div", { class: `verdict-word ${d.verdict}` }, VERDICT_WORD[d.verdict]),
    h("div", null, d.reason),
    draws.map((l) => {
      const cost = d.charges.find((c) => c.rule === l.rule!.id)?.cost ?? 0;
      const left = l.left?.risk !== undefined ? `${l.left.risk - cost} risk left after this` : l.left?.uses !== undefined ? `${l.left.uses - 1} left after this` : "";
      return h("div", { class: "note" }, `Draws on “${l.rule!.note ?? l.rule!.id}”${left ? `: ${left}` : ""}.`);
    }),
    d.when.length ? h("div", { class: "note" }, `The grant will require: ${d.when.map((w) => (w.c === "checks.pass" ? "checks pass" : w.c)).join(", ")}.`) : null,
    h("div", { class: "debug-only" }, layersTable(d)),
  );
}
