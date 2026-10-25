import { ApprovalCard } from "@okayed/design/okayed";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@okayed/design/ui/collapsible";
import { Textarea } from "@okayed/design/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@okayed/design/ui/toggle-group";
import { humanDuration, narrowGrant, personalLayer, type NarrowResult } from "@okayed/engine";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DRAFTS, NOW, REQUESTS, SAYINGS, TARGETS } from "./data";

/** What the person said, what a model drafted from it, and what okayed would actually ask them to approve. */
export function WordsView() {
  const [said, setSaid] = useState(SAYINGS[1]!);
  const [pending, setPending] = useState(Object.keys(REQUESTS)[0]!);
  const [draftName, setDraftName] = useState("prompt-injected");
  const [draft, setDraft] = useState(JSON.stringify(DRAFTS["prompt-injected"], null, 2));
  let proposal: unknown = draft;
  try {
    proposal = JSON.parse(draft);
  } catch {
    // Malformed model output is just an empty draft to the engine.
  }
  const req = REQUESTS[pending];
  const r = narrowGrant({ utterance: said, proposal, requests: req ? [req] : [], targets: TARGETS, policy: { layers: [personalLayer([])] }, now: NOW });
  const pick = (name: string) => {
    setDraftName(name);
    setDraft(typeof DRAFTS[name] === "string" ? (DRAFTS[name] as string) : JSON.stringify(DRAFTS[name], null, 2));
  };

  return (
    <main className="mx-auto grid max-w-5xl gap-8 px-4 py-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:px-8">
      <div className="space-y-6">
        <Field n="1" title="The person says">
          <Textarea value={said} onChange={(e) => setSaid(e.target.value)} rows={3} className="text-[15px]" aria-label="What the person says" />
          <div className="flex flex-wrap gap-1.5">
            {SAYINGS.map((s) => (
              <button key={s} type="button" onClick={() => setSaid(s)} className="rounded-full border bg-card px-3 py-1 text-left text-sm hover:border-primary/40 aria-pressed:border-primary aria-pressed:bg-primary/8" aria-pressed={s === said}>
                {s.length > 46 ? `${s.slice(0, 44)}…` : s}
              </button>
            ))}
          </div>
        </Field>
        <Field n="2" title="What's pending">
          <ToggleGroup type="single" variant="outline" size="sm" value={pending} onValueChange={(v) => v && setPending(v)} className="flex-wrap">
            {Object.keys(REQUESTS).map((k) => <ToggleGroupItem key={k} value={k}>{k}</ToggleGroupItem>)}
          </ToggleGroup>
        </Field>
        <Field n="3" title="A model drafts the grant (untrusted)">
          <ToggleGroup type="single" variant="outline" size="sm" value={draftName} onValueChange={(v) => v && pick(v)} className="flex-wrap">
            {Object.keys(DRAFTS).map((k) => <ToggleGroupItem key={k} value={k}>{k}</ToggleGroupItem>)}
          </ToggleGroup>
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 text-muted-foreground text-sm">
              <ChevronRightIcon className="size-4 transition-transform group-data-[state=open]:rotate-90" />Edit the draft
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Textarea value={draft} onChange={(e) => (setDraft(e.target.value), setDraftName(""))} rows={9} className="mt-2 font-mono text-xs" spellCheck={false} aria-label="The model's draft" />
            </CollapsibleContent>
          </Collapsible>
        </Field>
      </div>
      <div className="space-y-6">
        <Field n="4" title="What the person is asked to approve">
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

function Field({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h2 className="flex items-center gap-2 font-semibold">
        <span className="grid size-6 place-items-center rounded-full bg-primary/12 font-semibold text-primary text-xs">{n}</span>
        {title}
      </h2>
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
      state="pending"
      passkey="ready"
      onApprove={() => toast("In the demo, this signs a once-only grant with Face ID.")}
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
