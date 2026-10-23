import { decideAll, type Policy } from "@okayed/engine";
import { h, questionLine, ruleBlock, verdictView, type Question } from "@okayed/ui";
import type { App } from "../app.ts";

let question: Question | null = null;

const PRESETS = ["auto-approve read-only GitHub for 1 hour", "ask me before anything that spends money", "never deploy to production"];

/** Ask your own policy a question, then see its layers as blocks. Same pattern as the playground. */
export function policyView(app: App): HTMLElement {
  const { snap } = app;
  const policy: Policy = { layers: snap.policy.layers };
  const agents = snap.agents.map((a) => a.id);
  const targets = [
    ...snap.targets.repos.map((r) => `github:${r}`),
    ...snap.targets.prs.filter((p) => p.head).map((p) => `github:${p.repo}/pull/${p.number}@${p.head}`),
    ...snap.targets.sites.flatMap((s) => s.envs.map((e) => `site:${s.host}/${e}`)),
  ];
  question ??= { agent: agents[0] ?? "agent:assistant", act: "github.read", res: targets[0] ?? "github:adrianmross/okayed", later: 0 };
  const q = question;
  const decision = decideAll(policy, q.act, [q.res], snap.now + q.later);

  return h(
    "div",
    { class: "col" },
    h(
      "section",
      { class: "answer" },
      questionLine(q, { agents, targets }, (next) => ((question = next), app.rerender())),
      verdictView(decision),
    ),
    h("div", { class: "chips" }, PRESETS.map((p) => h("button", { class: "chip", type: "button", onclick: () => app.run("POST", "/chat", { text: p }, "Proposed. Apply it in the conversation.") }, p))),
    policy.layers.map((layer, i) =>
      h(
        "section",
        { class: "card" },
        h("div", { class: "card-head" }, h("strong", { style: "color:var(--ink)" }, layer.name), h("span", null, i === 0 ? "built in: the most any policy can allow" : `when nothing matches: ${layer.default}`)),
        layer.rules.length
          ? h("div", { class: "blocks" }, layer.rules.map((r) => ruleBlock(r, snap.now, i === 0 ? undefined : () => app.run("DELETE", `/rules/${encodeURIComponent(r.id)}`, undefined, "Rule removed."))))
          : h("div", { class: "note" }, "No rules yet, so everything asks you. Say a rule in Now."),
      ),
    ),
    snap.policy.warnings.map((w) => h("div", { class: "note" }, w)),
  );
}
