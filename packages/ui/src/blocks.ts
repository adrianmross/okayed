import { CATALOG, describeRule, humanDuration, labelRes, parseRes, type Beyond, type Decision, type GrantDraft, type Rule } from "@okayed/engine";
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

/** A policy rule as a block toned by its effect, with an optional remove button. */
export function ruleBlock(rule: Rule, now: number, onRemove?: () => void): HTMLElement {
  const b = block(rule.effect, describeRule(rule, now));
  if (onRemove) b.append(h("button", { class: "x", type: "button", "aria-label": "Remove rule", onclick: onRemove }, "×"));
  return b;
}

export const VERDICT_WORD: Record<Decision["verdict"], string> = { allow: "Yes", ask: "Asks you first", deny: "No" };

export function layersTable(d: Pick<Decision, "layers"> | { layers: { layer: string; verdict: string; why: string }[] }): HTMLElement {
  return h(
    "table",
    { class: "layers" },
    d.layers.map((l) => h("tr", null, h("td", null, l.layer), h("td", null, h("span", { class: `badge ${l.verdict}` }, l.verdict)), h("td", null, l.why))),
  );
}

/** The one-word answer and its reason; the per-layer breakdown is Debug-only. */
export function verdictView(d: Decision): HTMLElement {
  return h(
    "div",
    null,
    h("div", { class: `verdict-word ${d.verdict}` }, VERDICT_WORD[d.verdict]),
    h("div", null, d.reason),
    h("div", { class: "debug-only" }, layersTable(d)),
  );
}
