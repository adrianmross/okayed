import { ALWAYS_SPANS, ApprovalCard, BLOCK_SPANS, HOLD_DURATIONS, HoldSlide, SlideToConfirm, SwipeDecide, type ApprovalFlow, type ApprovalLayout, type ApprovalState } from "@okayed/design/okayed";
import { Button } from "@okayed/design/ui/button";
import { Switch } from "@okayed/design/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@okayed/design/ui/toggle-group";
import { BanIcon, CopyIcon, RepeatIcon, ScanFaceIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { PR } from "./data";

const REGISTRY = `${(import.meta.env.VITE_WEB_URL as string | undefined) ?? (import.meta.env.DEV ? "http://localhost:8787" : location.origin)}/r`;
type Passkey = "ready" | "setup" | "unsupported";

const lasting = (s: number | null | undefined) =>
  s === undefined ? "open the editor" : s === null ? "until removed" : (HOLD_DURATIONS.find((d) => d.seconds === s)?.label ?? ALWAYS_SPANS.find((d) => d.seconds === s)?.words.toLowerCase() ?? `${s} s`);

/** What the showcase card asks for. */
const ASKS = {
  deploy: { act: "site.deploy", res: ["site:openmeadow.org/production"], ttl: 1800, when: [], why: "I want to ship the latest build to production." },
  merge: { act: "github.pr.merge", res: [PR], ttl: 900, when: [{ c: "checks.pass" }], why: "Checks are green on #182, so it's ready to merge." },
  pay: { act: "spend.money", res: ["money:card-1/USD/12"], ttl: 900, when: [], why: "I want to buy openmeadow.dev for you." },
} as const;
type Ask = keyof typeof ASKS;

/** The registry's showcase: every way to lay out and make the decision, with what each one calls. */
export function ComponentsView() {
  const [layout, setLayout] = useState<ApprovalLayout>("stack");
  const [flow, setFlow] = useState<ApprovalFlow>("swipe");
  const [ask, setAsk] = useState<Ask>("deploy");
  const [block, setBlock] = useState(false);
  const [passkey, setPasskey] = useState<Passkey>("ready");
  const [state, setState] = useState<ApprovalState>("pending");
  const [log, setLog] = useState<{ n: number; text: string }[]>([]);
  const say = (text: string) => setLog((l) => [{ n: (l[0]?.n ?? 0) + 1, text }, ...l].slice(0, 8));

  const buttons = flow !== "swipe";
  const example = flow === "swipe" ? (ask === "pay" ? "approval-card-pay" : "approval-card-swipe") : flow === "hold" ? "approval-card-hold" : layout === "row" ? "approval-card-row" : "approval-card";
  const props = [flow !== "swipe" && `flow="${flow}"`, buttons && layout !== "stack" && `layout="${layout}"`, block && "onBlock={…}"].filter(Boolean).join(" ");
  const commands = `npx shadcn add ${REGISTRY}/${example}.json\n# or, with "@okayed": "${REGISTRY}/{name}.json" in components.json:\nnpx shadcn add @okayed/${example}`;

  return (
    <main className="mx-auto max-w-5xl space-y-10 px-4 py-8 md:px-8">
      <section className="space-y-1">
        <h1 className="font-semibold text-2xl">Components</h1>
        <p className="text-muted-foreground">Everything here installs into any shadcn app from okayed's registry. Pick how the decision looks and how it's made.</p>
      </section>

      <section className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
        <div className="space-y-5">
          <Control label="Request" hint="What the agent asks for. A payment is a money card.">
            <ToggleGroup type="single" variant="outline" size="sm" value={ask} onValueChange={(v) => v && (setAsk(v as Ask), setState("pending"))}>
              <ToggleGroupItem value="deploy">Deploy</ToggleGroupItem>
              <ToggleGroupItem value="merge">Merge</ToggleGroupItem>
              <ToggleGroupItem value="pay">Payment</ToggleGroupItem>
            </ToggleGroup>
          </Control>
          <Control label="Flow" hint="Swipe: swipe to allow; hold Always or Deny and rest on how long. Or buttons to tap, or to hold and slide up a ladder.">
            <ToggleGroup type="single" variant="outline" size="sm" value={flow} onValueChange={(v) => v && (setFlow(v as ApprovalFlow), setState("pending"))}>
              <ToggleGroupItem value="swipe">Swipe</ToggleGroupItem>
              <ToggleGroupItem value="tap">Tap</ToggleGroupItem>
              <ToggleGroupItem value="hold">Hold</ToggleGroupItem>
            </ToggleGroup>
          </Control>
          {buttons && (
            <Control label="Layout" hint="The main decision with two under it, or all of them in one row.">
              <ToggleGroup type="single" variant="outline" size="sm" value={layout} onValueChange={(v) => v && (setLayout(v as ApprovalLayout), setState("pending"))}>
                <ToggleGroupItem value="stack">Stack</ToggleGroupItem>
                <ToggleGroupItem value="row">Row</ToggleGroupItem>
              </ToggleGroup>
            </Control>
          )}
          <Control label="Block" hint={flow === "swipe" ? "Holding Deny offers how long to block requests like this." : "Offer Block…, a rule that blocks requests like this."}>
            <Switch checked={block} onCheckedChange={setBlock} aria-label="Offer blocking" />
          </Control>
          <Control label="Face ID" hint="Whether this browser has a passkey set up.">
            <ToggleGroup type="single" variant="outline" size="sm" value={passkey} onValueChange={(v) => v && setPasskey(v as Passkey)}>
              <ToggleGroupItem value="ready">Ready</ToggleGroupItem>
              <ToggleGroupItem value="setup">Not set up</ToggleGroupItem>
              <ToggleGroupItem value="unsupported">None</ToggleGroupItem>
            </ToggleGroup>
          </Control>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-medium text-sm">Install</span>
              <Button size="xs" variant="ghost" onClick={() => navigator.clipboard.writeText(commands.split("\n")[0]!).then(() => toast.success("Copied."), () => toast.error("Couldn't copy."))}>
                <CopyIcon />Copy
              </Button>
            </div>
            <pre className="overflow-x-auto rounded-xl bg-muted/60 p-3 font-mono text-xs leading-relaxed" data-testid="install">{commands}</pre>
            <pre className="overflow-x-auto rounded-xl bg-muted/60 p-3 font-mono text-xs">{`<ApprovalCard ${props ? `${props} ` : ""}… />`}</pre>
          </div>
        </div>

        <div className="space-y-3">
          <div className={buttons ? "pt-28" : ""}>
            <ApprovalCard
              layout={layout}
              flow={flow}
              agent="agent:assistant"
              act={ASKS[ask].act}
              res={[...ASKS[ask].res]}
              uses={1}
              ttl={ASKS[ask].ttl}
              when={[...ASKS[ask].when]}
              risk="high"
              why={ASKS[ask].why}
              what={ask === "pay" ? "openmeadow.dev, for a year" : undefined}
              method={ask === "pay" ? "Visa ···· 4242" : undefined}
              state={state}
              passkey={passkey}
              onApprove={() => (say("onApprove()"), setState("approved"))}
              onApprovePlain={() => say("onApprovePlain()")}
              onDeny={() => (say("onDeny()"), setState("denied"))}
              onAlwaysAllow={(s) => say(`onAlwaysAllow(${s === undefined ? "" : String(s)}) · ${lasting(s)}`)}
              {...(block ? { onBlock: (s?: number | null) => say(`onBlock(${s === undefined ? "" : String(s)}) · ${lasting(s)}`) } : {})}
            />
          </div>
          {state !== "pending" && <Button size="sm" variant="secondary" onClick={() => setState("pending")}>Ask again</Button>}
          <Log entries={log} />
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="font-semibold text-lg">The pieces on their own</h2>
          <p className="text-muted-foreground text-sm">Build your own decision area from these and pass it to the card as <code className="font-mono">actions</code>.</p>
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <Piece name="swipe-decide" title="SwipeDecide">
            <SwipeDecide
              onAllow={() => say("SwipeDecide: onAllow()")}
              back={{ word: "Deny", onBack: () => say("SwipeDecide: onBack()"), spans: BLOCK_SPANS, onSpan: (s) => say(`SwipeDecide: onSpan(${s.id})`) }}
              always={{ spans: ALWAYS_SPANS, onAlways: (s) => say(`SwipeDecide: onAlways(${s.id})`) }}
            />
          </Piece>
          <Piece name="swipe-decide" title="SwipeDecide, one row">
            <SwipeDecide title="Swipe to connect" onAllow={() => say("SwipeDecide (row): onAllow()")} back={{ word: "Not now", onBack: () => say("SwipeDecide (row): onBack()") }} />
          </Piece>
          <Piece name="slide-to-confirm" title="SlideToConfirm">
            <SlideToConfirm icon={<ScanFaceIcon />} onConfirm={() => say("SlideToConfirm: onConfirm()")} />
            <SlideToConfirm label="Slide to stop everything" tone="deny" onConfirm={() => say("SlideToConfirm (deny): onConfirm()")} />
          </Piece>
          <Piece name="hold-slide" title="HoldSlide">
            <div className="grid grid-cols-2 gap-2 pt-28">
              <HoldSlide label="Always allow…" verb="allow" icon={<RepeatIcon />} onTap={() => say("HoldSlide: onTap()")} onConfirm={(s) => say(`HoldSlide: onConfirm(${s.label})`)} />
              <HoldSlide label="Block…" verb="block" tone="deny" icon={<BanIcon />} onTap={() => say("HoldSlide (block): onTap()")} onConfirm={(s) => say(`HoldSlide (block): onConfirm(${s.label})`)} />
            </div>
          </Piece>
        </div>
      </section>
    </main>
  );
}

function Control({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="font-medium text-sm">{label}</div>
        <div className="text-muted-foreground text-xs">{hint}</div>
      </div>
      {children}
    </div>
  );
}

function Piece({ name, title, children }: { name: string; title: string; children: ReactNode }) {
  return (
    <div className="space-y-3 rounded-2xl border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono font-semibold text-sm">{title}</span>
        <code className="truncate font-mono text-muted-foreground text-xs">npx shadcn add @okayed/{name}</code>
      </div>
      {children}
    </div>
  );
}

function Log({ entries }: { entries: { n: number; text: string }[] }) {
  return (
    <div className="rounded-2xl border bg-card p-3">
      <div className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">Calls</div>
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-sm">Make a decision on the card to see what it calls.</p>
      ) : (
        <ol className="space-y-0.5 font-mono text-xs" data-testid="calls">
          {entries.map((e) => (
            <li key={e.n}>{e.text}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
