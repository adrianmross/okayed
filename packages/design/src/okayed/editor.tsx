import { decideAll, describeRule, YOU, type Effect, type Policy, type Rule, type SharedBudget, type Usage } from "@okayed/engine";
import { CheckCircle2Icon, GaugeIcon, MapPinIcon, SparklesIcon, Trash2Icon, UserIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "../ui/sheet";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { ACTIONS, actionMeta } from "./actions";
import { ActionTile, AgentAvatar, Step, StepJoin, Token, VerdictPill, agentName } from "./primitives";


export interface EditorWorld {
  agents: string[];
  repos: string[];
  sites: { host: string; envs: string[] }[];
  budgets: SharedBudget[];
  usage: Usage;
  now: number;
}

export interface RuleEditorProps {
  rule: Rule;
  isNew: boolean;
  /** All the person's rules; the editor returns the whole list with this one added, changed or removed. */
  rules: Rule[];
  world: EditorWorld;
  /** Resolve true to close the sheet. */
  onSave: (rules: Rule[], what: "added" | "saved" | "deleted") => Promise<boolean>;
  onClose: () => void;
  /** Shown above the steps for a new rule, e.g. a "say it in words" box. */
  describe?: ReactNode;
  /** The sheet's title and save button, when they should say more than "New rule" and "Add rule". */
  title?: string;
  saveLabel?: string;
}

export function blankRule(): Rule {
  return { id: `r-${Math.random().toString(36).slice(2, 9)}`, effect: "allow", act: "github.pr.merge", when: [{ c: "checks.pass" }] };
}

export const TILE_TITLE: Record<string, string> = {
  "github.read": "Read repos",
  "github.pr.comment": "Comment on PRs",
  "github.pr.merge": "Merge PRs",
  "site.deploy": "Deploy sites",
  "spend.money": "Spend money",
};

/** What an action reads as after "asks to": "merge pull requests". */
export const PHRASE: Record<string, string> = {
  "github.read": "read repos",
  "github.pr.comment": "comment on PRs",
  "github.pr.merge": "merge pull requests",
  "site.deploy": "deploy sites",
  "spend.money": "spend money",
  "*": "do anything",
};

/** A tile's name: the action, narrowed by where when the rule says ("Merge in okayed", "Deploy to staging"). */
export function tileTitle(r: Rule): { title: string; usedWhere: boolean } {
  const repo = /^github:[^/]+\/([^/*]+)\/\*\*$/.exec(r.res ?? "")?.[1];
  const env = /^site:[^/]+\/([^*/]+)$/.exec(r.res ?? "")?.[1];
  if (repo && r.act === "github.pr.merge") return { title: `Merge in ${repo}`, usedWhere: true };
  if (repo && r.act === "github.read") return { title: `Read ${repo}`, usedWhere: true };
  if (repo && r.act === "github.pr.comment") return { title: `Comment in ${repo}`, usedWhere: true };
  if (env && r.act === "site.deploy") return { title: `Deploy to ${env}`, usedWhere: true };
  return { title: TILE_TITLE[r.act] ?? actionMeta(r.act).title, usedWhere: false };
}

const COUNTS: [string, number | undefined][] = [["No limit", undefined], ["Once", 1], ["5 times", 5], ["10 times", 10], ["30 times", 30], ["100 times", 100]];
const HORIZONS: [string, number | undefined][] = [["No end", undefined], ["For 1 day", 86400], ["For 1 week", 7 * 86400], ["For 2 weeks", 14 * 86400], ["For 30 days", 30 * 86400]];

/** A tappable token that opens a list of choices, like a Shortcuts parameter. */
export function Choice<T>({ value, options, onPick, tone = "plain", label }: { value: T; options: [string, T, ReactNode?][]; onPick: (v: T) => void; tone?: Parameters<typeof Token>[0]["tone"]; label: string }) {
  const [open, setOpen] = useState(false);
  const current = options.find(([, v]) => JSON.stringify(v) === JSON.stringify(value))?.[0] ?? String(value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Token tone={tone} interactive aria-label={label}>{current}</Token>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1.5" align="start">
        {options.map(([text, v, icon]) => (
          <button
            key={text}
            type="button"
            onClick={() => (onPick(v), setOpen(false))}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent"
          >
            {icon}
            <span className="flex-1">{text}</span>
            {text === current && <CheckCircle2Icon className="size-4 text-primary" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

const StepIcon = ({ children, tone = "any" }: { children: ReactNode; tone?: "any" | "policy" }) => <ActionTile tone={tone} icon={children} size="sm" />;

/**
 * The rule editor, after a Siri Shortcuts automation: a stack of steps that read as one sentence, each value a token
 * you tap to change. Underneath, the plain-words rule and a live "try it" from the same engine okayed runs. Pure
 * props in, rules out, so the web app saves to the server and the playground keeps them in the browser.
 */
export function RuleEditor({ rule, isNew, rules, world, onSave, onClose, describe, title, saveLabel }: RuleEditorProps) {
  const [r, setR] = useState<Rule>(rule);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Rule>) => setR((x) => clean({ ...x, ...patch }));
  const kind = r.act.startsWith("github") ? "github" : r.act === "site.deploy" ? "site" : r.act === "spend.money" ? "money" : "any";
  const { agents, now } = world;

  const save = async (next: Rule[]) => {
    setSaving(true);
    const ok = await onSave(next, isNew ? "added" : next.length < rules.length ? "deleted" : "saved");
    setSaving(false);
    if (ok) onClose();
  };

  const asker = r.agent ?? agents[0] ?? "agent:demo";
  const trial = useMemo(() => tryIt(r, rules, world.budgets, now, world.repos[0] ?? "adrianmross/okayed", world.usage, asker), [r, rules, world, now, asker]);

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2"><ActionTile act={r.act === "*" ? undefined : r.act} size="sm" />{title ?? (isNew ? "New rule" : tileTitle(rule).title)}</SheetTitle>
          <SheetDescription>Tap any coloured word to change it.</SheetDescription>
        </SheetHeader>

        <div className="space-y-0 bg-muted/40 p-4">
          {isNew && describe}
          <Step icon={<StepIcon><UserIcon /></StepIcon>}>
            When{" "}
            <Choice
              label="Agent"
              value={r.agent}
              options={[["any agent", undefined, <UserIcon key="i" className="size-4" />], ...agents.map((a): [string, string | undefined, ReactNode] => [agentName(a), a, <AgentAvatar key={a} agent={a} className="size-5 text-[10px]" />])]}
              onPick={(agent) => set({ agent })}
            />{" "}
            asks to
          </Step>
          <StepJoin />
          <Step icon={<ActionTile act={r.act === "*" ? undefined : r.act} size="sm" />}>
            <ActionPicker value={r.act} onPick={(act) => set({ act, res: undefined, when: act === "github.pr.merge" ? r.when : undefined })} />
          </Step>
          {kind !== "any" && kind !== "money" && (
            <>
              <StepJoin />
              <Step icon={<StepIcon><MapPinIcon /></StepIcon>}>
                {kind === "github" ? (
                  <>
                    in{" "}
                    <Choice
                      label="Repository"
                      value={r.res}
                      options={[["any repository", undefined], ...world.repos.map((x): [string, string] => [x, `github:${x}/**`])]}
                      onPick={(res) => set({ res })}
                      tone="plain"
                    />
                  </>
                ) : (
                  <SitePicker value={r.res} sites={world.sites} onPick={(res) => set({ res })} />
                )}
              </Step>
            </>
          )}
          <StepJoin />
          <Step icon={<StepIcon tone="policy"><SparklesIcon /></StepIcon>}>
            <span className="mr-1">then</span>
            <EffectPicker value={r.effect} onPick={(effect) => set({ effect })} />
          </Step>
          {r.effect === "allow" && (
            <>
              {r.act === "github.pr.merge" && (
                <>
                  <StepJoin />
                  <Step icon={<StepIcon><CheckCircle2Icon /></StepIcon>}>
                    <label className="flex items-center justify-between gap-3">
                      <span>only if <Token tone="allow">checks pass</Token></span>
                      <Switch checked={!!r.when?.some((c) => c.c === "checks.pass")} onCheckedChange={(on) => set({ when: on ? [{ c: "checks.pass" }] : undefined })} aria-label="Only if checks pass" />
                    </label>
                  </Step>
                </>
              )}
              <StepJoin />
              <Step icon={<StepIcon><GaugeIcon /></StepIcon>}>
                <Choice label="How many times" value={r.budget?.uses} options={COUNTS} onPick={(uses) => set({ budget: uses ? { ...r.budget, uses } : r.budget?.risk ? { risk: r.budget.risk } : undefined })} />{" "}
                <span className="text-muted-foreground">·</span>{" "}
                <Choice
                  label="How long"
                  value={r.until === undefined ? undefined : HORIZONS.find(([, s]) => s && Math.abs(now + s - r.until!) < 120)?.[1] ?? r.until - now}
                  options={r.until !== undefined && !HORIZONS.some(([, s]) => s && Math.abs(now + s - r.until!) < 120) ? [[`For ${Math.round((r.until - now) / 86400)} days`, r.until - now], ...HORIZONS] : HORIZONS}
                  onPick={(s) => set({ until: s === undefined ? undefined : now + s })}
                />
              </Step>
            </>
          )}
        </div>

        <div className="space-y-3 p-4">
          <div className="rounded-xl border p-3">
            <div className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">In plain words</div>
            <p>{describeRule(r, now)}.</p>
          </div>
          {trial && (
            <div className="rounded-xl border p-3">
              <div className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">Try it</div>
              <p className="flex flex-wrap items-center gap-1.5">
                If {agentName(asker)} asked to {trial.ask} right now: <VerdictPill verdict={trial.verdict} />
              </p>
              {trial.reason && <p className="mt-1 text-muted-foreground text-sm">{trial.reason}</p>}
            </div>
          )}
        </div>

        <SheetFooter className="flex-row justify-between border-t">
          {!isNew ? (
            <Button variant="ghost" className="text-deny" disabled={saving} onClick={() => save(rules.filter((x) => x.id !== rule.id))}><Trash2Icon />Delete</Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button disabled={saving} onClick={() => save(isNew ? [...rules, r] : rules.map((x) => (x.id === rule.id ? r : x)))}>{saving && <Spinner />}{saveLabel ?? (isNew ? "Add rule" : "Save")}</Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** Drops empty optional fields so the stored rule stays tidy. */
function clean(r: Rule): Rule {
  const out = { ...r };
  for (const k of ["agent", "res", "until", "budget", "when", "note"] as const) {
    const v = out[k];
    if (v === undefined || (Array.isArray(v) && !v.length) || (typeof v === "object" && v && !Array.isArray(v) && !Object.keys(v).length)) delete out[k];
  }
  delete out.note;
  return out;
}

function ActionPicker({ value, onPick }: { value: string; onPick: (act: string) => void }) {
  const [open, setOpen] = useState(false);
  const meta = actionMeta(value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Token tone={meta.tone} interactive aria-label="Action">{PHRASE[value] ?? meta.noun}</Token>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="start">
        <div className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">Actions</div>
        <div className="grid grid-cols-3 gap-2">
          {[...Object.values(ACTIONS), { act: "*", title: "Anything", tone: "any" as const }].map((a) => (
            <button
              key={a.act}
              type="button"
              onClick={() => (onPick(a.act), setOpen(false))}
              className="flex flex-col items-center gap-1.5 rounded-xl p-2 text-center text-xs hover:bg-accent data-[on=true]:bg-accent"
              data-on={a.act === value}
            >
              <ActionTile act={a.act === "*" ? undefined : a.act} size="md" />
              {a.title}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SitePicker({ value, sites, onPick }: { value?: string; sites: { host: string; envs: string[] }[]; onPick: (res?: string) => void }) {
  const m = /^site:([^/]+)\/(.+)$/.exec(value ?? "");
  const host = m?.[1] && m[1] !== "*" ? m[1] : undefined;
  const env = m?.[2] && m[2] !== "*" ? m[2] : undefined;
  const make = (h?: string, e?: string) => (h || e ? `site:${h ?? "*"}/${e ?? "*"}` : undefined);
  const envs = [...new Set(sites.flatMap((s) => s.envs))];
  return (
    <>
      to{" "}
      <Choice label="Site" value={host} options={[["any site", undefined], ...sites.map((s): [string, string] => [s.host, s.host])]} onPick={(h) => onPick(make(h, env))} />{" "}
      in{" "}
      <Choice label="Environment" value={env} tone={env === "production" ? "ask" : "plain"} options={[["any environment", undefined], ...envs.map((e): [string, string] => [e, e])]} onPick={(e) => onPick(make(host, e))} />
    </>
  );
}

function EffectPicker({ value, onPick }: { value: Effect; onPick: (e: Effect) => void }) {
  const opts: [Effect, string, string][] = [
    ["allow", "Allow", "bg-allow text-white"],
    ["ask", "Ask me", "bg-ask text-black/80"],
    ["deny", "Block", "bg-deny text-white"],
  ];
  return (
    <span className="inline-flex gap-1 rounded-xl bg-muted p-1 align-middle">
      {opts.map(([e, label, on]) => (
        <button key={e} type="button" aria-pressed={value === e} onClick={() => onPick(e)} className={`rounded-lg px-3 py-1 font-semibold text-sm leading-6 transition ${value === e ? on : "text-muted-foreground hover:text-foreground"}`}>
          {label}
        </button>
      ))}
    </span>
  );
}

/** The editor's live answer: the same engine, with this rule in place of the one being edited. */
export function tryIt(r: Rule, rules: Rule[], budgets: SharedBudget[], now: number, repo: string, usage: Usage, agent = r.agent ?? "agent:demo") {
  const act = r.act === "*" || r.act.endsWith("*") ? "github.pr.merge" : r.act;
  const site = /^site:([^*/]+)\/([^*]+)$/.exec(r.res ?? "");
  const repoFromRule = /^github:([^/]+\/[^/*]+)\/\*\*$/.exec(r.res ?? "")?.[1] ?? repo;
  const sample: Record<string, [string, string]> = {
    "github.read": [`github:${repoFromRule}`, `read ${repoFromRule}`],
    "github.pr.comment": [`github:${repoFromRule}/pull/1`, `comment on PR #1 in ${repoFromRule}`],
    "github.pr.merge": [`github:${repoFromRule}/pull/1@${"a".repeat(40)}`, `merge PR #1 in ${repoFromRule}`],
    "site.deploy": [`site:${site?.[1] ?? "openmeadow.org"}/${site?.[2] ?? "staging"}`, `deploy ${site?.[1] ?? "openmeadow.org"} to ${site?.[2] ?? "staging"}`],
    "spend.money": ["money:card-1/USD/20", "spend $20"],
  };
  const s = sample[act];
  if (!s) return null;
  const others = rules.filter((x) => x.id !== r.id);
  const policy: Policy = { layers: [{ name: YOU, default: "ask", rules: [...others, r] }], ...(budgets.length ? { budgets } : {}) };
  const d = decideAll(policy, act, [s[0]], now, { agent, usage });
  return { verdict: d.verdict, reason: d.reason, ask: s[1] };
}

