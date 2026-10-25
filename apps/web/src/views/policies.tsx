import type { Card } from "@okayed/core";
import { ActionTile, NewPolicyTile, PolicyEditor, PolicyTile, blankRule, tileTitle } from "@okayed/design/okayed";
import { Button } from "@okayed/design/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@okayed/design/ui/dropdown-menu";
import { Input } from "@okayed/design/ui/input";
import { Spinner } from "@okayed/design/ui/spinner";
import { describeBudget, ruleParts, YOU, type Rule, type SharedBudget } from "@okayed/engine";
import { CalendarClockIcon, PlusIcon, Trash2Icon, WandSparklesIcon } from "lucide-react";
import { useState } from "react";
import { Page, Section } from "../components/page";
import { useOkayed } from "../lib/okayed";

export function PoliciesView() {
  const { snap, run } = useOkayed();
  const [editing, setEditing] = useState<{ rule: Rule; isNew: boolean } | null>(null);
  if (!snap) return <Page title="Policies"><Spinner /></Page>;
  const mine = snap.policy.layers.find((l) => l.name === YOU);
  const rules = mine?.rules ?? [];
  const now = snap.now;

  return (
    <Page
      title="Policies"
      description="What your agents may do without asking. Each policy is a standing rule; every action under it still gets its own once-only grant."
      actions={<Button onClick={() => setEditing({ rule: blankRule(), isNew: true })}><PlusIcon />New policy</Button>}
    >
      <div className="space-y-10">
        <Section title="Your policies" description={`When nothing matches, okayed ${mine?.default === "ask" ? "asks you" : mine?.default}.`}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {rules.map((r) => {
              const p = ruleParts(r, now, snap.usage);
              const spent = !!r.budget && /^0 of/.test(p.budget ?? "");
              const t = tileTitle(r);
              const sub = [!t.usedWhere && p.where, p.agent && `for ${p.agent}`, p.only && `if ${p.only}`, p.budget, p.horizon].filter(Boolean).join(" · ");
              return (
                <PolicyTile
                  key={r.id}
                  act={r.act}
                  effect={r.effect}
                  spent={spent}
                  title={t.title}
                  subtitle={sub || (r.effect === "allow" ? "anywhere, any time" : r.effect === "ask" ? "always asks" : "never allowed")}
                  onClick={() => setEditing({ rule: r, isNew: false })}
                />
              );
            })}
            <NewPolicyTile onClick={() => setEditing({ rule: blankRule(), isNew: true })} />
          </div>
        </Section>
        <BudgetsSection budgets={snap.policy.budgets} />
      </div>
      {editing && (
        <PolicyEditor
          key={editing.rule.id}
          rule={editing.rule}
          isNew={editing.isNew}
          rules={rules}
          world={{ agents: [...new Set(["agent:assistant", ...snap.agents.map((a) => a.id), ...snap.targets.agents])], repos: snap.targets.repos, sites: snap.targets.sites, budgets: snap.policy.budgets, usage: snap.usage, now }}
          onSave={async (next, what) => (await run("PUT", "/policy", { rules: next }, `Policy ${what}.`)) !== undefined}
          onClose={() => setEditing(null)}
          describe={<DescribeIt onApplied={() => setEditing(null)} />}
        />
      )}
    </Page>
  );
}

/** "Or just say it": the sentence goes through the same drafting and narrowing as the chat. */
function DescribeIt({ onApplied }: { onApplied: () => void }) {
  const okayed = useOkayed();
  const [text, setText] = useState("");
  const [card, setCard] = useState<Card | null>(null);
  const [busy, setBusy] = useState(false);
  const draft = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setCard((await okayed.run<Card>("POST", "/chat", { text })) ?? null);
    setBusy(false);
  };
  return (
    <div className="mb-4 space-y-2 rounded-2xl border bg-card p-3">
      <form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), draft())}>
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Or say it: “let assistant merge anything in okayed for 2 weeks”" aria-label="Describe a policy" />
        <Button type="submit" variant="secondary" disabled={busy || !text.trim()} aria-label="Draft it">{busy ? <Spinner /> : <WandSparklesIcon />}</Button>
      </form>
      {card && card.kind === "policy" && card.status === "open" && (
        <div className="space-y-2">
          {(card.ruleTexts ?? []).map((t) => <p key={t} className="text-sm">• {t}</p>)}
          {card.beyond.length > 0 && <p className="text-muted-foreground text-xs">okayed narrowed {card.beyond.length} thing{card.beyond.length > 1 ? "s" : ""} the draft asked for.</p>}
          <Button size="sm" onClick={async () => (await okayed.approve(card.id)) && onApplied()}>Apply with Face ID</Button>
        </div>
      )}
      {card && card.kind !== "policy" && <p className="text-muted-foreground text-sm">{card.sentence}</p>}
    </div>
  );
}

const BUDGET_PRESETS = (now: number): [string, SharedBudget][] => [
  ["Everything: 100 risk this week", { id: `week-${now.toString(36)}`, risk: 100, until: now + 7 * 86400, note: "everything, this week" }],
  ["Merges: 10 a day", { id: `merges-${now.toString(36)}`, scope: { act: "github.pr.merge" }, uses: 10, until: now + 86400, note: "merges today" }],
  ["Assistant: 50 risk this week, counting my okays", { id: `assistant-${now.toString(36)}`, scope: { agent: "agent:assistant" }, risk: 50, counts: "all", until: now + 7 * 86400, note: "Assistant this week" }],
];

function BudgetsSection({ budgets }: { budgets: SharedBudget[] }) {
  const okayed = useOkayed();
  const snap = okayed.snap!;
  const save = (next: SharedBudget[], ok: string) => okayed.run("PUT", "/budgets", { budgets: next }, ok);
  return (
    <Section
      title="Shared budgets"
      description="Optional. A budget caps auto-approvals across every policy in its scope; when it runs out, okayed asks you instead."
      action={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm"><PlusIcon />Add budget</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {BUDGET_PRESETS(snap.now).map(([label, b]) => (
              <DropdownMenuItem key={label} onSelect={() => save([...budgets, b], "Budget added.")}>{label}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      {budgets.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-5 text-center text-muted-foreground text-sm">No budgets. Policies go ahead as often as they allow.</div>
      ) : (
        <div className="divide-y rounded-2xl border bg-card">
          {budgets.map((b, i) => {
            const d = describeBudget(b, snap.now, snap.usage);
            const spent = snap.usage[`budget:${b.id}`];
            return (
              <div key={b.id} className="flex items-center gap-3 p-3">
                <ActionTile act={b.scope?.act} icon={b.scope?.act ? undefined : <CalendarClockIcon />} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{d.scope[0]!.toUpperCase() + d.scope.slice(1)}</div>
                  <div className="text-muted-foreground text-sm">{[d.left, d.horizon, d.counts].filter(Boolean).join(" · ")}</div>
                </div>
                {spent && (spent.uses > 0 || spent.risk > 0) && (
                  <Button size="sm" variant="ghost" onClick={() => okayed.run("POST", `/rules/${encodeURIComponent(`budget:${b.id}`)}/topup`, undefined, "Topped up.")}>Top up</Button>
                )}
                <Button size="icon-sm" variant="ghost" aria-label="Remove budget" onClick={() => save(budgets.filter((_, j) => j !== i), "Budget removed.")}><Trash2Icon /></Button>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
