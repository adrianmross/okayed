import { CATALOG, DEFAULT_POSTURE, decideAll, lint, narrowPolicy, personalLayer, policyClauses, type Beyond, type Layer, type Policy, type Rule, type SharedBudget, type Usage } from "@okayed/engine";
import { budgetBlock, budgetPresets, cutBlocks, h, questionLine, ruleBlock, verdictView, VERDICT_WORD, type Question } from "@okayed/ui";
import { NOW, PR, QUESTION_TARGETS, TARGETS } from "./data.ts";

let layer: Layer = personalLayer();
let budgets: SharedBudget[] = [];
let usage: Usage = {};
let history: Layer[] = [];
let question: Question = { agent: "agent:assistant", act: "github.pr.merge", res: PR, later: 0 };
let sentence = "let assistant merge anything in okayed when checks pass for 2 weeks, up to 3 merges";
let lastCut: Beyond[] = [];
let lastQuestion: { text: string; options: string[] } | null = null;

const policy = (l = layer): Policy => ({ layers: [l], ...(budgets.length ? { budgets } : {}) });
const id = () => `w${Math.random().toString(36).slice(2, 8)}`;

const EXAMPLES: [string, Partial<Question>][] = [
  ["Can assistant merge #182?", { act: "github.pr.merge", res: PR }],
  ["Can assistant read matrix?", { act: "github.read", res: "github:adrianmross/matrix" }],
  ["Can assistant deploy to staging?", { act: "site.deploy", res: "site:openmeadow.org/staging" }],
  ["Can assistant deploy to production?", { act: "site.deploy", res: "site:openmeadow.org/production" }],
  ["Can assistant spend $20?", { act: "spend.money", res: "money:card-1/USD/20" }],
];

const WHAT_IFS: [string, (l: Layer) => Layer][] = [
  ["ask before every merge", (l) => ({ ...l, rules: [...l.rules, { id: id(), effect: "ask", act: "github.pr.merge", res: "github:adrianmross/**", note: "ask before every merge" }] })],
  ["let assistant merge in okayed 3 times", (l) => ({ ...l, rules: [...l.rules, { id: id(), effect: "allow", act: "github.pr.merge", res: "github:adrianmross/okayed/**", agent: "agent:assistant", budget: { uses: 3 }, note: "assistant may merge in okayed 3 times" }] })],
  ["never deploy to production", (l) => ({ ...l, rules: [...l.rules, { id: id(), effect: "deny", act: "site.deploy", res: "site:*/production", note: "never deploy to production" }] })],
  ["block everything on matrix", (l) => ({ ...l, rules: [...l.rules, { id: id(), effect: "deny", act: "*", res: "github:adrianmross/matrix/**", note: "block everything on matrix" }] })],
  ["ask about everything", () => personalLayer([])],
  ["balanced posture", () => personalLayer(DEFAULT_POSTURE)],
];

function change(next: Layer, rerender: () => void): void {
  history.push(layer);
  layer = next;
  rerender();
}

/** The playground has no model: rules come from the sentence's own clauses, then through the same narrowing. */
function applySentence(rerender: () => void): void {
  const rules = policyClauses(sentence, TARGETS).flatMap((c) =>
    !c.effect
      ? []
      : (c.acts.length ? c.acts : c.everything ? Object.keys(CATALOG) : []).map((act) => ({
          effect: c.effect,
          act,
          ...(c.ttl ? { ttl: c.ttl } : {}),
          ...(c.uses ? { uses: c.uses } : {}),
          ...(c.agents.length === 1 ? { agent: c.agents[0] } : {}),
          ...(c.conditions.length ? { when: c.conditions } : {}),
        })),
  );
  const r = narrowPolicy({ utterance: sentence, proposal: { rules }, policy: policy(), layer: "you", targets: TARGETS, now: NOW });
  if (r.kind === "question") {
    lastQuestion = { text: r.question, options: r.options };
    return rerender();
  }
  lastQuestion = null;
  lastCut = r.beyond;
  change(r.layer, rerender);
}

/** Spends one use of whatever the current answer draws on, as an auto-approval would. */
function useIt(rerender: () => void): void {
  const d = decideAll(policy(), question.act, [question.res], NOW + question.later, { agent: question.agent, usage });
  if (d.verdict !== "allow") return;
  usage = { ...usage };
  for (const c of d.charges) {
    const u = usage[c.key] ?? { uses: 0, risk: 0 };
    usage[c.key] = { uses: u.uses + 1, risk: u.risk + c.cost };
  }
  rerender();
}

export function policySection(rerender: () => void): HTMLElement {
  const now = NOW + question.later;
  const ctx = { agent: question.agent, usage };
  const decision = decideAll(policy(), question.act, [question.res], now, ctx);
  const input = h("input", { class: "field", value: sentence, "data-focus": "policy", "aria-label": "Policy in plain words", oninput: (e: Event) => (sentence = (e.target as HTMLInputElement).value) });

  const whatIfs = WHAT_IFS.map(([label, apply]) => {
    const v = decideAll(policy(apply(layer)), question.act, [question.res], now, ctx).verdict;
    const moves = v !== decision.verdict;
    return h("button", { class: "chip", type: "button", "aria-pressed": String(moves), onclick: () => change(apply(layer), rerender) }, label, moves ? ` → ${VERDICT_WORD[v]}` : "");
  });

  return h(
    "section",
    { class: "col" },
    h(
      "section",
      { class: "answer" },
      questionLine(question, { agents: [...TARGETS.agents, "agent:buzz"], targets: QUESTION_TARGETS }, (q) => ((question = q), rerender())),
      verdictView(decision),
      decision.verdict === "allow" && decision.charges.length ? h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: () => useIt(rerender) }, "Use it once"), h("span", { class: "note" }, "spends from the budget, as an auto-approval would")) : null,
    ),
    h("div", { class: "chips" }, EXAMPLES.map(([label, q]) => h("button", { class: "chip", type: "button", onclick: () => ((question = { ...question, ...q }), rerender()) }, label))),
    h("h2", { class: "section-title" }, "What if… (chips that change the answer are highlighted)"),
    h("div", { class: "chips" }, whatIfs),
    h("h2", { class: "section-title" }, "Say a standing policy"),
    h("form", { class: "compose", onsubmit: (e: Event) => (e.preventDefault(), applySentence(rerender)) }, input, h("button", { class: "btn primary", type: "submit" }, "Apply")),
    lastQuestion
      ? h(
          "div",
          { class: "card" },
          h("div", { class: "line" }, lastQuestion.text),
          h("div", { class: "chips" }, lastQuestion.options.map((o) => h("button", { class: "chip", type: "button", onclick: () => ((sentence = `${sentence} ${o}`), applySentence(rerender)) }, o))),
        )
      : null,
    cutBlocks(lastCut),
    h(
      "section",
      { class: "card" },
      h(
        "div",
        { class: "card-head" },
        h("strong", { style: "color:var(--ink)" }, "Your policies"),
        h("span", null, `when nothing matches: ${layer.default}`),
        h("span", { class: "spacer" }),
        Object.keys(usage).length ? h("button", { class: "btn quiet", type: "button", onclick: () => ((usage = {}), rerender()) }, "Reset budgets") : null,
      ),
      layer.rules.length
        ? h(
            "div",
            { class: "blocks" },
            layer.rules.map((r: Rule, i) =>
              ruleBlock(r, now, usage, {
                change: (next) => change({ ...layer, rules: layer.rules.map((x, j) => (j === i ? next : x)) }, rerender),
                remove: () => change({ ...layer, rules: layer.rules.filter((_, j) => j !== i) }, rerender),
                topUp: () => {
                  usage = { ...usage };
                  delete usage[r.id];
                  rerender();
                },
              }),
            ),
          )
        : h("div", { class: "note" }, "No policies: everything asks you."),
    ),
    h(
      "section",
      { class: "card" },
      h("div", { class: "card-head" }, h("strong", { style: "color:var(--ink)" }, "Shared budgets"), h("span", null, "optional; span every policy in their scope")),
      budgets.length
        ? h(
            "div",
            { class: "blocks" },
            budgets.map((b, i) =>
              budgetBlock(b, now, usage, {
                remove: () => ((budgets = budgets.filter((_, j) => j !== i)), rerender()),
                topUp: () => {
                  usage = { ...usage };
                  delete usage[`budget:${b.id}`];
                  rerender();
                },
              }),
            ),
          )
        : h("div", { class: "note" }, "None. Add one to cap auto-approvals across policies: for everything, one action, or one agent."),
      h("div", { class: "chips" }, budgetPresets(NOW).map(([label, b]) => h("button", { class: "chip", type: "button", onclick: () => ((budgets = [...budgets, { ...b, id: `${b.id}-${budgets.length}` }]), rerender()) }, `+ ${label}`))),
    ),
    lint(policy(), now).map((w) => h("div", { class: "note" }, `${w.layer}: ${w.message}`)),
    history.length ? h("div", null, h("button", { class: "btn quiet", type: "button", onclick: () => ((layer = history.pop()!), rerender()) }, "Undo")) : null,
  );
}
