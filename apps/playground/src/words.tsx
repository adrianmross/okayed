import { ActionTile, AgentAvatar, ApprovalCard, Choice, agentName } from "@okayed/design/okayed";
import { Button } from "@okayed/design/ui/button";
import { Switch } from "@okayed/design/ui/switch";
import { Textarea } from "@okayed/design/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@okayed/design/ui/toggle-group";
import { humanDuration, labelRes, narrowGrant, personalLayer, type NarrowResult, type Request } from "@okayed/engine";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
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
  const [said, setSaid] = useState(SAYINGS[1]!.text);
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
        <Field n="1" title="The person says" hint="Type anything, or try one of these. Each tests something different.">
          <Textarea value={said} onChange={(e) => setSaid(e.target.value)} rows={3} className="text-[15px]" aria-label="What the person says" />
          <div className="grid gap-1.5">
            {SAYINGS.map((s) => (
              <button key={s.text} type="button" onClick={() => setSaid(s.text)} aria-pressed={s.text === said} className="flex items-baseline gap-3 rounded-xl border bg-card px-3 py-2 text-left text-sm transition hover:border-primary/40 aria-pressed:border-primary aria-pressed:bg-primary/8">
                <span className="w-32 shrink-0 font-medium text-muted-foreground text-xs">{s.label}</span>
                <span className="min-w-0">“{s.text}”</span>
              </button>
            ))}
          </div>
        </Field>
        <Field n="2" title="What's pending" hint="Requests agents are waiting on. Switch them in and out of the queue, or add one; okayed binds the words to one of these, or asks which.">
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
          <Result r={r} />
        </Field>
        {r.kind === "grant" && (
          <Field n="5" title="Draft against grant">
            <Diff r={r} />
          </Field>
        )}
      </div>
    </main>
  );
}

type Queued = { r: Request; on: boolean; added: boolean };

/** The queue of pending requests: each one switched in or out, and more to add. */
function Queue({ queue, setQueue }: { queue: Queued[]; setQueue: (f: (q: Queued[]) => Queued[]) => void }) {
  const [agent, setAgent] = useState(AGENTS[1]!);
  const [act, setAct] = useState("github.pr.merge");
  const [res, setRes] = useState(PR);
  const on = queue.filter((q) => q.on).length;
  const add = () =>
    setQueue((q) => [...q, { r: { id: `r_${q.length + 1}`, aud: agent, act, res: [res], why: "added in the playground", at: NOW - 30, exp: NOW + 1800 }, on: true, added: true }]);
  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      <div className="flex items-center justify-between border-b px-3 py-2 text-xs">
        <span className="font-medium">{on === 0 ? "Nothing pending" : `${on} waiting`}</span>
        <span className="text-muted-foreground">{queue.length - on} switched off</span>
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
      <div className="flex flex-wrap items-center gap-x-1 gap-y-2 border-t border-dashed bg-muted/30 px-3 py-2.5 text-sm">
        <Choice label="Agent" value={agent} options={AGENTS.map((a): [string, string] => [agentName(a), a])} onPick={setAgent} />
        wants to
        <Choice label="Action" value={act} tone="merge" options={Object.keys(TARGETS_FOR).map((a): [string, string] => [VERB[a] ?? a, a])} onPick={(a) => (setAct(a), setRes(TARGETS_FOR[a]![0]!))} />
        <Choice label="Target" value={res} options={TARGETS_FOR[act]!.map((t): [string, string] => [labelRes(t), t])} onPick={setRes} />
        <Button size="sm" variant="secondary" className="ml-auto" onClick={add}><PlusIcon />Add</Button>
      </div>
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
