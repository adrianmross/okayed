import { CATALOG, humanDuration, labelRes } from "@okayed/engine";
import { h } from "./dom.ts";

export interface Question {
  agent: string;
  act: string;
  res: string;
  /** Seconds from now. */
  later: number;
}

export interface QuestionOptions {
  agents: string[];
  targets: string[];
  laters?: number[];
}

function select(value: string, options: [string, string][], onPick: (v: string) => void, tone: string, label: string): HTMLElement {
  return h(
    "span",
    { class: `block ${tone}`, style: "display:inline" },
    h(
      "select",
      { class: "pill", "aria-label": label, onchange: (e: Event) => onPick((e.target as HTMLSelectElement).value) },
      options.map(([v, text]) => h("option", { value: v, selected: v === value }, text)),
    ),
  );
}

/** "Can [assistant] [merge] [PR #182 …] [now]?" with every part a pill you can change. */
export function questionLine(q: Question, opts: QuestionOptions, onChange: (q: Question) => void): HTMLElement {
  const set = (patch: Partial<Question>) => onChange({ ...q, ...patch });
  const acts = Object.values(CATALOG).map((a) => [a.act, a.verb] as [string, string]);
  const targets = [...new Set([q.res, ...opts.targets])].map((r) => [r, labelRes(r)] as [string, string]);
  const laters = (opts.laters ?? [0, 1800, 3600, 8 * 3600]).map((s) => [String(s), s ? `in ${humanDuration(s)}` : "now"] as [string, string]);
  const agents = [...new Set([q.agent, ...opts.agents])].map((a) => [a, a.replace(/^agent:/, "")] as [string, string]);
  return h(
    "div",
    { class: "ask-line" },
    "Can ",
    select(q.agent, agents, (agent) => set({ agent }), "who", "Agent"),
    " ",
    select(q.act, acts, (act) => set({ act }), "what", "Action"),
    " ",
    select(q.res, targets, (res) => set({ res }), "what", "Target"),
    " ",
    select(String(q.later), laters, (v) => set({ later: Number(v) }), "time", "When"),
    "?",
  );
}
