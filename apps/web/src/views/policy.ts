import { DEFAULT_POSTURE, decideAll, YOU, type Policy, type Rule } from "@okayed/engine";
import { budgetBlock, budgetPresets, h, questionLine, ruleBlock, verdictView, type Question } from "@okayed/ui";
import type { App } from "../app.ts";

let question: Question | null = null;

const PRESETS = [
  "let assistant merge anything in okayed when checks pass for 2 weeks, up to 30 merges",
  "auto-approve staging deploys",
  "never deploy to production",
  "ask me before anything that spends money",
];

/**
 * Your standing policies. Ask a question to see which one decides and what it would draw; change a pill to edit a
 * policy in place; say a new one in words. Same pattern as the playground.
 */
export function policyView(app: App): HTMLElement {
  const { snap } = app;
  const budgets = snap.policy.budgets;
  const policy: Policy = { layers: snap.policy.layers, ...(budgets.length ? { budgets } : {}) };
  const saveBudgets = (next: typeof budgets, ok: string) => app.run("PUT", "/budgets", { budgets: next }, ok);
  const mine = policy.layers.find((l) => l.name === YOU);
  const agents = snap.agents.map((a) => a.id);
  const targets = [
    ...snap.targets.repos.map((r) => `github:${r}`),
    ...snap.targets.prs.filter((p) => p.head).map((p) => `github:${p.repo}/pull/${p.number}@${p.head}`),
    ...snap.targets.sites.flatMap((s) => s.envs.map((e) => `site:${s.host}/${e}`)),
  ];
  question ??= { agent: agents[0] ?? "agent:assistant", act: "github.pr.merge", res: targets.find((t) => t.includes("/pull/")) ?? targets[0] ?? "github:adrianmross/okayed", later: 0 };
  const q = question;
  const decision = decideAll(policy, q.act, [q.res], snap.now + q.later, { agent: q.agent, usage: snap.usage });
  const save = (rules: Rule[], ok: string) => app.run("PUT", "/policy", { rules }, ok);

  return h(
    "div",
    { class: "col" },
    h("section", { class: "answer" }, questionLine(q, { agents, targets }, (next) => ((question = next), app.rerender())), verdictView(decision)),
    h("h2", { class: "section-title" }, "Say a new policy"),
    h("div", { class: "chips" }, PRESETS.map((p) => h("button", { class: "chip", type: "button", onclick: () => app.run("POST", "/chat", { text: p }, "Drafted. Apply it under Now.") }, p))),
    policy.layers.map((layer) =>
      h(
        "section",
        { class: "card" },
        h(
          "div",
          { class: "card-head" },
          h("strong", { style: "color:var(--ink)" }, layer === mine ? "Your policies" : layer.name),
          h("span", null, layer === mine ? `when nothing matches: ${layer.default}` : "set above you; you can only narrow it"),
          h("span", { class: "spacer" }),
          layer === mine ? h("button", { class: "btn quiet", type: "button", onclick: () => save(DEFAULT_POSTURE, "Back to the balanced posture.") }, "Reset to balanced") : null,
        ),
        layer.rules.length
          ? h(
              "div",
              { class: "blocks" },
              layer.rules.map((r, i) =>
                layer === mine
                  ? ruleBlock(r, snap.now, snap.usage, {
                      change: (next) => save(layer.rules.map((x, j) => (j === i ? next : x)), "Policy updated."),
                      remove: () => save(layer.rules.filter((_, j) => j !== i), "Policy removed."),
                      topUp: () => app.run("POST", `/rules/${encodeURIComponent(r.id)}/topup`, undefined, "Topped up."),
                    })
                  : ruleBlock(r, snap.now, snap.usage),
              ),
            )
          : h("div", { class: "note" }, "No policies, so everything asks you."),
      ),
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
              budgetBlock(b, snap.now, snap.usage, {
                remove: () => saveBudgets(budgets.filter((_, j) => j !== i), "Budget removed."),
                topUp: () => app.run("POST", `/rules/${encodeURIComponent(`budget:${b.id}`)}/topup`, undefined, "Topped up."),
              }),
            ),
          )
        : h("div", { class: "note" }, "None. Add one to cap auto-approvals across policies: for everything, one action, or one agent."),
      h("div", { class: "chips" }, budgetPresets(snap.now).map(([label, b]) => h("button", { class: "chip", type: "button", onclick: () => saveBudgets([...budgets, b], "Budget added.") }, `+ ${label}`))),
    ),
    snap.policy.warnings.map((w) => h("div", { class: "note" }, w)),
  );
}
