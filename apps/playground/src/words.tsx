import { ActionTile, AgentAvatar, ApprovalCard, Choice, agentName } from "@okayed/design/okayed";
import { Button } from "@okayed/design/ui/button";
import { Switch } from "@okayed/design/ui/switch";
import { Textarea } from "@okayed/design/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@okayed/design/ui/toggle-group";
import { humanDuration, labelRes, narrowGrant, personalLayer, type NarrowResult, type Request } from "@okayed/engine";
import { PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { DRAFTS, NOW, PR, REQUESTS, SAYINGS, TARGETS } from "./data";

const AGENTS = ["agent:assistant", "agent:ci-bot"];
const VERB: Record<string, string> = { "github.read": "read", "github.pr.comment": "comment on", "github.pr.merge": "merge", "site.deploy": "deploy", "spend.money": "spend" };
/** What each action can be asked about here. */
const TARGETS_FOR: Record<string, string[]> = {
  "github.read": ["github:adrianmross/okayed", "github:adrianmross/matrix"],
  "github.pr.comment": [PR],
  "github.pr.merge": [PR],
  "site.deploy": ["site:openmeadow.org/production", "site:openmeadow.org/staging", "site:buzz.dev/production"],
  "spend.money": ["money:card-1/USD/20"],
};

/** What the person said, what a model drafted from it, and what okayed would actually ask them to approve. */
export function WordsView() {
  const [said, setSaid] = useState("");
  const [queue, setQueue] = useState(REQUESTS.map((r, i) => ({ r, on: i === 0, added: false })));
  const [draftName, setDraftName] = useState("prompt-injected");
  const [draft, setDraft] = useState(JSON.stringify(DRAFTS["prompt-injected"], null, 2));
  let proposal: unknown = draft;
  try {
    proposal = JSON.parse(draft);
  } catch {
    // Malformed model output is just an empty draft to the engine.
  }
  const pending = queue.filter((q) => q.on).map((q) => q.r);
  const r = narrowGrant({ utterance: said, proposal, requests: pending, targets: TARGETS, policy: { layers: [personalLayer([])] }, now: NOW });
  const pick = (name: string) => {
    setDraftName(name);
    setDraft(typeof DRAFTS[name] === "string" ? (DRAFTS[name] as string) : JSON.stringify(DRAFTS[name], null, 2));
  };

  return (
    <main className="mx-auto grid max-w-5xl gap-8 px-4 py-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:px-8">
      <div className="space-y-6">
        <Field n="1" title="The person says" hint="Type what someone might tell their agent. Press Tab to take a suggestion.">
          <GhostInput value={said} onChange={setSaid} />
        </Field>
        <Field n="2" title="What's pending" hint="What agents are waiting on. okayed ties the words to one of these, or asks which.">
          <Queue queue={queue} setQueue={setQueue} />
        </Field>
        <Field n="3" title="A model drafts the grant (untrusted)" hint="Whatever the model returns, okayed only keeps what the words and the queue support.">
          <ToggleGroup type="single" variant="outline" size="sm" value={draftName} onValueChange={(v) => v && pick(v)} className="flex-wrap">
            {Object.keys(DRAFTS).map((k) => <ToggleGroupItem key={k} value={k}>{k}</ToggleGroupItem>)}
          </ToggleGroup>
          <Textarea value={draft} onChange={(e) => (setDraft(e.target.value), setDraftName(""))} rows={9} className="font-mono text-xs" spellCheck={false} aria-label="The model's draft" />
        </Field>
      </div>
      <div className="space-y-6">
        <Field n="4" title="What the person is asked to allow">
          {said.trim() ? <Result r={r} /> : <div className="rounded-2xl border border-dashed p-6 text-center text-muted-foreground text-sm">What the person says decides what they're asked. Start typing, or press Tab for an example.</div>}
        </Field>
        {said.trim() && r.kind === "grant" && (
          <Field n="5" title="Draft against grant">
            <Diff r={r} />
          </Field>
        )}
      </div>
    </main>
  );
}

/**
 * A text box that suggests the rest, like an editor's autocomplete: empty, it types out an example in ghost text;
 * typing the start of one shows its end. Tab takes it (or Space on an empty box, or a tap on the ghost).
 */
function GhostInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [n, setN] = useState(0);
  const [shown, setShown] = useState(0);
  const example = SAYINGS[n % SAYINGS.length]!;
  const match = value ? SAYINGS.find((x) => x.text.toLowerCase().startsWith(value.toLowerCase()) && x.text.length > value.length) : example;
  const rest = match ? match.text.slice(value.length) : "";
  // Empty: type the example out, hold it, then move to the next one.
  useEffect(() => {
    if (value) return;
    setShown(0);
    let i = 0;
    const type = setInterval(() => {
      i += 1;
      setShown(i);
      if (i >= example.text.length) clearInterval(type);
    }, 28);
    const next = setTimeout(() => setN((x) => x + 1), example.text.length * 28 + 2600);
    return () => (clearInterval(type), clearTimeout(next));
  }, [value, example.text]);
  const ghost = value ? rest : rest.slice(0, shown);
  const take = () => match && onChange(match.text);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!match) return;
    if (e.key === "Tab" || (e.key === " " && !value) || (e.key === "ArrowRight" && e.currentTarget.selectionStart === value.length)) {
      e.preventDefault();
      take();
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Textarea value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} rows={3} className="text-[15px] md:text-[15px]" aria-label="What the person says" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 whitespace-pre-wrap break-words border border-transparent px-3 py-2 text-[15px]">
          <span className="text-transparent">{value}</span>
          <span className="pointer-events-auto cursor-pointer text-muted-foreground/60" onClick={take}>{ghost}</span>
        </div>
      </div>
      <div className="flex h-5 items-center gap-2 text-muted-foreground text-xs">
        {match ? (
          <>
            <span>{match.label}</span>
            <button type="button" onClick={take} className="rounded border px-1 font-mono text-[10px] hover:text-foreground">Tab</button>
            {!value && <button type="button" onClick={() => setN((x) => x + 1)} aria-label="Another example" className="hover:text-foreground"><RefreshCwIcon className="size-3" /></button>}
          </>
        ) : (
          value && <button type="button" onClick={() => onChange("")} className="hover:text-foreground">Clear</button>
        )}
      </div>
    </div>
  );
}

type Queued = { r: Request; on: boolean; added: boolean };

/** The queue of pending requests: each one switched in or out, and more to add. */
function Queue({ queue, setQueue }: { queue: Queued[]; setQueue: (f: (q: Queued[]) => Queued[]) => void }) {
  const [agent, setAgent] = useState(AGENTS[1]!);
  const [act, setAct] = useState("github.pr.merge");
  const [res, setRes] = useState(PR);
  const [adding, setAdding] = useState(false);
  const on = queue.filter((q) => q.on).length;
  const add = () => {
    setQueue((q) => [...q, { r: { id: `r_${q.length + 1}`, aud: agent, act, res: [res], why: "added in the playground", at: NOW - 30, exp: NOW + 1800 }, on: true, added: true }]);
    setAdding(false);
  };
  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      <div className="flex items-center justify-between border-b px-3 py-2 text-xs">
        <span className="font-medium">{on === 0 ? "Nothing pending" : `${on} waiting`}</span>
        <Button size="xs" variant="ghost" onClick={() => setAdding(!adding)}>{adding ? <XIcon /> : <PlusIcon />}{adding ? "Cancel" : "Add"}</Button>
      </div>
      <ul className="divide-y">
        {queue.map((q, i) => (
          <li key={q.r.id} className={`flex items-center gap-3 px-3 py-2.5 transition ${q.on ? "" : "opacity-50"}`}>
            <span className="relative">
              <ActionTile act={q.r.act} size="sm" />
              <AgentAvatar agent={q.r.aud} className="-right-1.5 -bottom-1.5 absolute size-4 text-[8px] ring-2 ring-card" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm"><span className="font-medium">{agentName(q.r.aud)}</span> wants to {VERB[q.r.act] ?? q.r.act} {labelRes(q.r.res[0]!)}</div>
              <div className="text-muted-foreground text-xs">“{q.r.why}” · expires in {humanDuration(q.r.exp - NOW)}</div>
            </div>
            {q.added && <Button size="icon-xs" variant="ghost" aria-label="Remove" onClick={() => setQueue((x) => x.filter((_, j) => j !== i))}><XIcon /></Button>}
            <Switch checked={q.on} onCheckedChange={(v) => setQueue((x) => x.map((y, j) => (j === i ? { ...y, on: v } : y)))} aria-label={q.on ? "In the queue" : "Out of the queue"} />
          </li>
        ))}
      </ul>
      {adding && <div className="flex flex-wrap items-center gap-x-1 gap-y-2 border-t border-dashed bg-muted/30 px-3 py-2.5 text-sm">
        <Choice label="Agent" value={agent} options={AGENTS.map((a): [string, string] => [agentName(a), a])} onPick={setAgent} />
        wants to
        <Choice label="Action" value={act} tone="merge" options={Object.keys(TARGETS_FOR).map((a): [string, string] => [VERB[a] ?? a, a])} onPick={(a) => (setAct(a), setRes(TARGETS_FOR[a]![0]!))} />
        <Choice label="Target" value={res} options={TARGETS_FOR[act]!.map((t): [string, string] => [labelRes(t), t])} onPick={setRes} />
        <Button size="sm" className="ml-auto" onClick={add}>Add to queue</Button>
      </div>}
    </div>
  );
}

function Field({ n, title, hint, children }: { n: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h2 className="flex items-center gap-2 font-semibold">
        <span className="grid size-6 place-items-center rounded-full bg-primary/12 font-semibold text-primary text-xs">{n}</span>
        {title}
      </h2>
      {hint && <p className="-mt-1 text-muted-foreground text-sm">{hint}</p>}
      {children}
    </section>
  );
}

function Result({ r }: { r: NarrowResult }) {
  if (r.kind === "question") return <div className="rounded-2xl border bg-card p-4"><div className="font-semibold">okayed asks instead of guessing</div><p className="mt-1">{r.question}</p>{r.options.length > 0 && <p className="mt-2 text-muted-foreground text-sm">Options: {r.options.join(", ")}</p>}</div>;
  if (r.kind === "refuse") return <div className="rounded-2xl border bg-card p-4"><div className="font-semibold text-deny">Refused</div><p className="mt-1">{r.reason}</p></div>;
  const d = r.draft;
  return (
    <ApprovalCard
      agent={d.aud}
      act={d.act}
      res={d.res}
      uses={d.uses}
      ttl={d.exp - d.nbf}
      when={d.when}
      risk={d.risk}
      cuts={r.beyond}
      detailsOpen
      state="pending"
      passkey="ready"
      onApprove={() => toast("In the demo, this signs a one-time permission with Face ID.")}
      onDeny={() => toast("Denied. Nothing would run.")}
    />
  );
}

function Diff({ r }: { r: Extract<NarrowResult, { kind: "grant" }> }) {
  const a = r.asked;
  const d = r.draft;
  const rows: [string, string[], string[]][] = [
    ["Action", a.act ? [a.act] : [], [d.act]],
    ["Targets", a.res ?? [], d.res],
    ["Lifetime", a.ttl !== undefined ? [humanDuration(a.ttl)] : [], [humanDuration(d.exp - d.nbf)]],
    ["Uses", a.uses !== undefined ? [String(a.uses)] : [], [String(d.uses)]],
    ["Agent", a.aud ? [a.aud] : [], [d.aud]],
    ["Conditions", a.when?.map((c) => c.c) ?? [], d.when.map((c) => c.c)],
  ];
  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-muted-foreground text-xs">
          <tr><th className="px-3 py-2 font-medium">Field</th><th className="px-3 py-2 font-medium">Model drafted</th><th className="px-3 py-2 font-medium">okayed grants</th></tr>
        </thead>
        <tbody className="divide-y">
          {rows.map(([k, asked, got]) => (
            <tr key={k} className="align-top">
              <td className="px-3 py-2 text-muted-foreground">{k}</td>
              <td className="break-all px-3 py-2 font-mono text-xs">{asked.length ? asked.map((x) => <div key={x}>{got.includes(x) ? x : <s className="text-deny">{x}</s>}</div>) : "—"}</td>
              <td className="break-all px-3 py-2 font-mono text-xs">{got.length ? got.map((x) => <div key={x} className={asked.length && !asked.includes(x) ? "font-semibold text-allow" : ""}>{x}</div>) : "none"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
