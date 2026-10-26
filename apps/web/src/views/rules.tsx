import type { Card } from "@okayed/core";
import { ActionTile, NewRuleTile, RuleEditor, RuleTile, agentName, blankRule, tileTitle } from "@okayed/design/okayed";
import { Button } from "@okayed/design/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@okayed/design/ui/dropdown-menu";
import { Input } from "@okayed/design/ui/input";
import { Spinner } from "@okayed/design/ui/spinner";
import { describeBudget, ruleParts, type Rule, type SharedBudget } from "@okayed/engine";
import { CalendarClockIcon, PlusIcon, RotateCcwIcon, ScanFaceIcon, Trash2Icon, WandSparklesIcon } from "lucide-react";
import { useState } from "react";
import { useEditorWorld, useRules } from "../components/always-allow";
import { Page, Section } from "../components/page";
import { useOkayed } from "../lib/okayed";

export function RulesView() {
  const { snap, run } = useOkayed();
  const world = useEditorWorld();
  const rules = useRules();
  const [editing, setEditing] = useState<{ rule: Rule; isNew: boolean } | null>(null);
  if (!snap || !world) return <Page title="Rules"><Spinner /></Page>;
  const now = snap.now;

  return (
    <Page
      title="Rules"
      description="What your agents may do without asking you. A rule covers many actions, and each one still gets its own one-time permission."
      actions={<Button onClick={() => setEditing({ rule: blankRule(), isNew: true })}><PlusIcon />New rule</Button>}
    >
      <div className="space-y-10">
        <Section title="Your rules" description="When no rule matches, okayed asks you.">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {rules.map((r) => {
              const p = ruleParts(r, now, snap.usage);
              const spent = !!r.budget && /^0 of/.test(p.budget ?? "");
              const t = tileTitle(r);
              const sub = [!t.usedWhere && p.where, r.agent && `for ${agentName(r.agent)}`, p.only && `if ${p.only}`, p.budget, p.horizon].filter(Boolean).join(" · ");
              return (
                <RuleTile
                  key={r.id}
                  act={r.act}
                  effect={r.effect}
                  spent={spent}
                  title={t.title}
                  subtitle={sub || (r.effect === "allow" ? "anywhere, any time" : r.effect === "ask" ? "always asks" : "always blocked")}
                  onClick={() => setEditing({ rule: r, isNew: false })}
                />
              );
            })}
            <NewRuleTile onClick={() => setEditing({ rule: blankRule(), isNew: true })} />
          </div>
        </Section>
        <LimitsSection budgets={snap.policy.budgets} />
      </div>
      {editing && (
        <RuleEditor
          key={editing.rule.id}
          rule={editing.rule}
          isNew={editing.isNew}
          rules={rules}
          world={world}
          onSave={async (next, what) => (await run("PUT", "/policy", { rules: next }, `Rule ${what}.`)) !== undefined}
          onClose={() => setEditing(null)}
          describe={<DescribeIt onApplied={() => setEditing(null)} />}
        />
      )}
    </Page>
  );
}

/** "Or say it": the sentence goes through the same drafting and narrowing as the chat. */
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
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Or say it: “always allow merges in okayed for 2 weeks”" aria-label="Describe a rule" />
        <Button type="submit" variant="secondary" disabled={busy || !text.trim()} aria-label="Draft it">{busy ? <Spinner /> : <WandSparklesIcon />}</Button>
      </form>
      {card && card.kind === "policy" && card.status === "open" && (
        <div className="space-y-2">
          {(card.ruleTexts ?? []).map((t) => <p key={t} className="text-sm">• {t}</p>)}
          {card.beyond.length > 0 && <p className="text-muted-foreground text-xs">Left out {card.beyond.length} thing{card.beyond.length > 1 ? "s" : ""} the draft asked for.</p>}
          <Button size="sm" onClick={async () => (await okayed.approve(card.id)) && onApplied()}><ScanFaceIcon />Add rule</Button>
        </div>
      )}
      {card && card.kind !== "policy" && <p className="text-muted-foreground text-sm">{card.sentence}</p>}
    </div>
  );
}

const LIMIT_PRESETS = (now: number): [string, SharedBudget][] => [
  ["Everything: 100 points this week", { id: `week-${now.toString(36)}`, risk: 100, until: now + 7 * 86400, note: "everything, this week" }],
  ["Merges: 10 a day", { id: `merges-${now.toString(36)}`, scope: { act: "github.pr.merge" }, uses: 10, until: now + 86400, note: "merges today" }],
  ["The assistant: 50 points this week, counting what I allow", { id: `assistant-${now.toString(36)}`, scope: { agent: "agent:assistant" }, risk: 50, counts: "all", until: now + 7 * 86400, note: "the assistant this week" }],
];

/** Limits are shared budgets: a cap across every rule they cover. Points weigh each action by its risk. */
function LimitsSection({ budgets }: { budgets: SharedBudget[] }) {
  const okayed = useOkayed();
  const snap = okayed.snap!;
  const save = (next: SharedBudget[], ok: string) => okayed.run("PUT", "/budgets", { budgets: next }, ok);
  return (
    <Section
      title="Limits"
      description="Optional. A limit caps how much your rules allow on their own; when it runs out, okayed asks you instead. Points weigh actions by risk: a read is 1, a comment 3, a merge or production deploy 8, a purchase 20."
      action={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm"><PlusIcon />Add limit</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {LIMIT_PRESETS(snap.now).map(([label, b]) => (
              <DropdownMenuItem key={label} onSelect={() => save([...budgets, b], "Limit added.")}>{label}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      {budgets.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-5 text-center text-muted-foreground text-sm">No limits. Rules allow things as often as they say.</div>
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
                  <Button size="sm" variant="ghost" onClick={() => okayed.run("POST", `/rules/${encodeURIComponent(`budget:${b.id}`)}/topup`, undefined, "Limit reset.")}><RotateCcwIcon />Reset</Button>
                )}
                <Button size="icon-sm" variant="ghost" aria-label="Remove limit" onClick={() => save(budgets.filter((_, j) => j !== i), "Limit removed.")}><Trash2Icon /></Button>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
