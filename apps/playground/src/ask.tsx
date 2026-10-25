import { ActionTile, AgentAvatar, Choice, NewPolicyTile, PolicyEditor, PolicyTile, blankRule, tileTitle, PHRASE } from "@okayed/design/okayed";
import { Button } from "@okayed/design/ui/button";
import { CATALOG, DEFAULT_POSTURE, decideAll, labelRes, personalLayer, ruleParts, type Policy, type Rule, type SharedBudget, type Usage } from "@okayed/engine";
import { useState } from "react";
import { NOW, QUESTION_TARGETS, TARGETS } from "./data";

const WORD = { allow: "Yes", ask: "Asks you first", deny: "No" } as const;
const WORD_CLS = { allow: "text-allow", ask: "text-[color-mix(in_oklch,var(--ask)_75%,var(--foreground))]", deny: "text-deny" } as const;
const WHEN: [string, number][] = [["now", 0], ["in an hour", 3600], ["tomorrow", 86400], ["in two weeks", 14 * 86400]];

const PRESETS: [string, Rule[]][] = [
  ["Balanced", DEFAULT_POSTURE],
  ["Cautious", [{ id: "c:read", effect: "allow", act: "github.read" }]],
  ["Ask for everything", []],
];

const BUDGETS: [string, SharedBudget][] = [
  ["Merges: 3 a day", { id: "merges", scope: { act: "github.pr.merge" }, uses: 3, until: NOW + 86400, note: "merges today" }],
  ["Everything: 40 risk", { id: "all", risk: 40, note: "everything" }],
];

/** Ask a policy a question, change the policy like a Shortcut, and watch the answer move. Nothing leaves the page. */
export function AskView() {
  const [rules, setRules] = useState<Rule[]>(DEFAULT_POSTURE);
  const [budgets, setBudgets] = useState<SharedBudget[]>([]);
  const [usage, setUsage] = useState<Usage>({});
  const [q, setQ] = useState({ agent: "agent:assistant", act: "github.pr.merge", res: QUESTION_TARGETS[2]!, later: 0 });
  const [editing, setEditing] = useState<{ rule: Rule; isNew: boolean } | null>(null);
  const policy: Policy = { layers: [personalLayer(rules)], ...(budgets.length ? { budgets } : {}) };
  const now = NOW + q.later;
  const d = decideAll(policy, q.act, [q.res], now, { agent: q.agent, usage });
  const decidedBy = d.layers.find((l) => l.rule)?.rule;

  const useOnce = () =>
    setUsage((u) => {
      const next = { ...u };
      for (const c of d.charges) next[c.key] = { uses: (next[c.key]?.uses ?? 0) + 1, risk: (next[c.key]?.risk ?? 0) + c.cost };
      return next;
    });

  return (
    <main className="mx-auto max-w-5xl space-y-10 px-4 py-8 md:px-8">
      <section className="space-y-4 rounded-3xl border bg-card p-5 shadow-sm md:p-7">
        <p className="text-[22px] leading-[2.2] md:text-[26px]">
          Can{" "}
          <Choice label="Agent" value={q.agent} options={[["assistant", "agent:assistant"], ["buzz", "agent:buzz"]]} onPick={(agent) => setQ({ ...q, agent })} />{" "}
          <Choice label="Action" value={q.act} tone="merge" options={Object.keys(CATALOG).map((a): [string, string] => [PHRASE[a] ?? a, a])} onPick={(act) => setQ({ ...q, act })} />{" "}
          <Choice label="Target" value={q.res} options={QUESTION_TARGETS.map((r): [string, string] => [labelRes(r), r])} onPick={(res) => setQ({ ...q, res })} />{" "}
          <Choice label="When" value={q.later} options={WHEN} onPick={(later) => setQ({ ...q, later })} />?
        </p>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className={`font-semibold text-4xl ${WORD_CLS[d.verdict]}`}>{WORD[d.verdict]}</div>
            <p className="mt-1 text-muted-foreground">{d.reason}</p>
            {d.decidedBy?.startsWith("budget:") ? (
              <p className="mt-1 text-muted-foreground text-sm">The policy allows it, but a shared budget it draws on has run out.</p>
            ) : (
              decidedBy && <p className="mt-1 text-muted-foreground text-sm">Decided by “{decidedBy.note ?? tileTitle(decidedBy).title}”.</p>
            )}
          </div>
          {d.verdict === "allow" && (
            <Button variant="secondary" onClick={useOnce}>Use it once</Button>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold text-lg">Policies</h2>
            <p className="text-muted-foreground text-sm">Tap one to change it. Start from a preset:</p>
          </div>
          <div className="flex gap-1.5">
            {PRESETS.map(([name, r]) => (
              <Button key={name} size="sm" variant="outline" onClick={() => (setRules(r), setUsage({}))}>{name}</Button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {rules.map((r) => {
            const p = ruleParts(r, now, usage);
            const t = tileTitle(r);
            return (
              <PolicyTile
                key={r.id}
                act={r.act}
                effect={r.effect}
                spent={!!r.budget && /^0 of/.test(p.budget ?? "")}
                title={t.title}
                subtitle={[!t.usedWhere && p.where, p.agent && `for ${p.agent}`, p.only && `if ${p.only}`, p.budget, p.horizon].filter(Boolean).join(" · ") || (r.effect === "allow" ? "anywhere, any time" : "always asks")}
                onClick={() => setEditing({ rule: r, isNew: false })}
              />
            );
          })}
          <NewPolicyTile onClick={() => setEditing({ rule: blankRule(), isNew: true })} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold text-lg">Shared budgets</h2>
        <div className="flex flex-wrap items-center gap-2">
          {budgets.map((b) => (
            <span key={b.id} className="inline-flex items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-2 text-sm">
              <ActionTile act={b.scope?.act} size="sm" className="size-5 [&_svg]:size-3" />
              {b.note} · {b.uses !== undefined ? `${Math.max(0, b.uses - (usage[`budget:${b.id}`]?.uses ?? 0))} of ${b.uses} left` : `${Math.max(0, (b.risk ?? 0) - (usage[`budget:${b.id}`]?.risk ?? 0))} of ${b.risk} risk left`}
              <Button size="xs" variant="ghost" onClick={() => setBudgets(budgets.filter((x) => x !== b))}>Remove</Button>
            </span>
          ))}
          {BUDGETS.filter(([, b]) => !budgets.some((x) => x.id === b.id)).map(([label, b]) => (
            <Button key={label} size="sm" variant="outline" onClick={() => setBudgets([...budgets, b])}>+ {label}</Button>
          ))}
          {Object.keys(usage).length > 0 && <Button size="sm" variant="ghost" onClick={() => setUsage({})}>Reset what's been spent</Button>}
        </div>
      </section>

      {editing && (
        <PolicyEditor
          key={editing.rule.id}
          rule={editing.rule}
          isNew={editing.isNew}
          rules={rules}
          world={{ agents: ["agent:assistant", "agent:buzz"], repos: TARGETS.repos, sites: TARGETS.sites.map((s) => ({ ...s, envs: [...new Set([...s.envs, "staging", "preview"])] })), budgets, usage, now }}
          onSave={async (next) => (setRules(next), true)}
          onClose={() => setEditing(null)}
        />
      )}
      <p className="text-center text-muted-foreground text-sm">
        <AgentAvatar agent="agent:assistant" className="mr-1 size-5 align-middle text-[10px]" /> Every answer here comes from okayed's engine, running in your browser.
      </p>
    </main>
  );
}
