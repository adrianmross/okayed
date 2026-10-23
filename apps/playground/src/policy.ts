import { BASELINE, CATALOG, decideAll, lint, narrowPolicy, policyClauses, type Beyond, type Layer, type Policy, type Rule } from "@okayed/engine";
import { cutBlocks, h, questionLine, ruleBlock, toast, verdictView, VERDICT_WORD, type Question } from "@okayed/ui";
import { NOW, PR, QUESTION_TARGETS, TARGETS } from "./data.ts";

let layer: Layer = { name: "you", default: "ask", rules: [] };
let history: Layer[] = [];
let question: Question = { agent: "agent:assistant", act: "github.read", res: "github:adrianmross/okayed", later: 0 };
let sentence = "auto-approve read-only GitHub for 1 hour; ask me before anything that spends money";
let lastCut: Beyond[] = [];

const policy = (l = layer): Policy => ({ layers: [BASELINE, l] });
const ruleId = () => `w${Math.random().toString(36).slice(2, 8)}`;

const EXAMPLES: [string, Partial<Question>][] = [
  ["Can assistant read okayed?", { act: "github.read", res: "github:adrianmross/okayed" }],
  ["Can assistant merge #182?", { act: "github.pr.merge", res: PR }],
  ["Can assistant deploy to production?", { act: "site.deploy", res: "site:openmeadow.org/production" }],
  ["Can assistant spend $20?", { act: "spend.money", res: "money:card-1/USD/20" }],
];

const WHAT_IFS: [string, (l: Layer) => Layer][] = [
  ["auto-approve reading GitHub for 1 h", (l) => ({ ...l, rules: [...l.rules, { id: ruleId(), effect: "allow", act: "github.read", until: NOW + 3600 }] })],
  ["never deploy to production", (l) => ({ ...l, rules: [...l.rules, { id: ruleId(), effect: "deny", act: "site.deploy", res: "site:*/production" }] })],
  ["auto-approve merges", (l) => ({ ...l, rules: [...l.rules, { id: ruleId(), effect: "allow", act: "github.pr.merge" }] })],
  ["block everything on matrix", (l) => ({ ...l, rules: [...l.rules, { id: ruleId(), effect: "deny", act: "*", res: "github:adrianmross/matrix/**" }] })],
  ["clear my rules", (l) => ({ ...l, rules: [] })],
];

function change(next: Layer, rerender: () => void): void {
  history.push(layer);
  layer = next;
  rerender();
}

/** The playground has no model: rules come from the sentence's own clauses, then through the same narrowing. */
function applySentence(rerender: () => void): void {
  const rules = policyClauses(sentence, TARGETS).flatMap((c) =>
    !c.effect ? [] : (c.acts.length ? c.acts : c.everything ? Object.keys(CATALOG) : []).map((act) => ({ effect: c.effect, act, ...(c.ttl ? { ttl: c.ttl } : {}) })),
  );
  const r = narrowPolicy({ utterance: sentence, proposal: { rules }, policy: policy(), layer: "you", targets: TARGETS, now: NOW });
  if (r.kind === "question") return toast(r.question);
  lastCut = r.beyond;
  change(r.layer, rerender);
}

export function policySection(rerender: () => void): HTMLElement {
  const now = NOW + question.later;
  const decision = decideAll(policy(), question.act, [question.res], now);
  const input = h("input", { class: "field", value: sentence, "data-focus": "policy", "aria-label": "Policy in plain words", oninput: (e: Event) => (sentence = (e.target as HTMLInputElement).value) });

  const whatIfs = WHAT_IFS.map(([label, apply]) => {
    const v = decideAll(policy(apply(layer)), question.act, [question.res], now).verdict;
    const moves = v !== decision.verdict;
    return h("button", { class: "chip", type: "button", "aria-pressed": String(moves), title: VERDICT_WORD[v], onclick: () => change(apply(layer), rerender) }, label, moves ? ` → ${VERDICT_WORD[v]}` : "");
  });

  return h(
    "section",
    { class: "col" },
    h("section", { class: "answer" }, questionLine(question, { agents: TARGETS.agents, targets: QUESTION_TARGETS }, (q) => ((question = q), rerender())), verdictView(decision)),
    h("div", { class: "chips" }, EXAMPLES.map(([label, q]) => h("button", { class: "chip", type: "button", onclick: () => ((question = { ...question, ...q }), rerender()) }, label))),
    h("h2", { class: "section-title" }, "What if… (one tap; chips that change the answer are highlighted)"),
    h("div", { class: "chips" }, whatIfs),
    h("h2", { class: "section-title" }, "Your policy, in plain words"),
    h("form", { class: "compose", onsubmit: (e: Event) => (e.preventDefault(), applySentence(rerender)) }, input, h("button", { class: "btn primary", type: "submit" }, "Apply")),
    cutBlocks(lastCut),
    [BASELINE, layer].map((l, i) =>
      h(
        "section",
        { class: "card" },
        h("div", { class: "card-head" }, h("strong", { style: "color:var(--ink)" }, l.name), h("span", null, i === 0 ? "built in: the most any policy can allow" : `when nothing matches: ${l.default}`)),
        l.rules.length
          ? h("div", { class: "blocks" }, l.rules.map((r: Rule) => ruleBlock(r, now, i === 0 ? undefined : () => change({ ...layer, rules: layer.rules.filter((x) => x !== r) }, rerender))))
          : h("div", { class: "note" }, "No rules: everything asks you."),
      ),
    ),
    lint(policy(), now).map((w) => h("div", { class: "note" }, `${w.layer}: ${w.message}`)),
    history.length ? h("div", null, h("button", { class: "btn quiet", type: "button", onclick: () => ((layer = history.pop()!), rerender()) }, "Undo")) : null,
  );
}
