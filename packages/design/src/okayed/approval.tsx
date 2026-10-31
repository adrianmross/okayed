import { humanDuration, labelRes, parseRes, type Beyond, type Condition, type Risk } from "@okayed/engine";
import { ChevronRightIcon, InfoIcon, ScissorsIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../lib/utils";
import { actionMeta } from "./actions";
import { ApprovalActions, type ApprovalFlow, type ApprovalLayout } from "./approval-actions";
import { Decided } from "./decided";
import type { HoldStep } from "./hold-slide";
import { MoneyCard, type MoneyState } from "./money";
import { ActionTile, AgentAvatar, Token, agentName } from "./primitives";
import { ALWAYS_SPANS, BLOCK_SPANS, SwipeDecide, type Span } from "./swipe-decide";

export type ApprovalState = "pending" | "approving" | "approved" | "denied" | "expired";

export interface ApprovalCardProps {
  agent: string;
  act: string;
  res: string[];
  uses: number;
  ttl: number;
  when: Condition[];
  risk: Risk;
  /** The agent's reason, in its words: shown as its claim, under the question. */
  why?: string;
  cuts?: Beyond[];
  state: ApprovalState;
  /** "ready": allow with Face ID; "setup": offer to set it up first; "unsupported": a plain okay. */
  passkey: "ready" | "setup" | "unsupported";
  approvedVia?: string;
  onApprove: () => void;
  onApprovePlain?: () => void;
  /** "Always": with no argument, open the rule editor; from a span, its seconds (null: until removed). */
  onAlwaysAllow?: (forSeconds?: number | null) => void;
  /** Block requests like this: the same, for a rule that blocks them. */
  onBlock?: (forSeconds?: number | null) => void;
  onDeny: () => void;
  /** How it's decided. "swipe" (the default): swipe to allow, with Always and Deny to hold or tap. "tap" and "hold": buttons. */
  flow?: ApprovalFlow;
  /** For the button flows: the main decision full width ("stack") or all in a row. */
  layout?: ApprovalLayout;
  /** For the "hold" button flow: the ladder it climbs. */
  durations?: HoldStep[];
  /** For the swipe flow: how long Always lasts, and how long a block from a held Deny lasts. */
  alwaysSpans?: Span[];
  blockSpans?: Span[];
  /** The header's service and mark; from the action by default. */
  service?: string;
  serviceIcon?: ReactNode;
  /** A payment's purpose and how it would be paid, for the money card. */
  what?: ReactNode;
  method?: string;
  /** Show the scope and limits without a tap. */
  detailsOpen?: boolean;
  /** Replaces the decision area entirely, for implementations that build their own. */
  actions?: ReactNode;
  className?: string;
}

/** "Merge [PR #182] in [adrianmross/okayed]": the action with its exact targets as tokens. */
export function ActionSentence({ act, res }: { act: string; res: string[] }) {
  const meta = actionMeta(act);
  const verb = meta.verb[0]!.toUpperCase() + meta.verb.slice(1);
  return (
    <span>
      {verb}
      {res.map((r, i) => {
        const x = parseRes(r);
        const sep = i === 0 ? " " : " and ";
        if (x?.kind === "github.pr") return <span key={r}>{sep}<Token tone={meta.tone}>PR #{x.number}</Token> in <Token tone="plain">{x.owner}/{x.repo}</Token></span>;
        if (x?.kind === "site") return <span key={r}>{sep}<Token tone={meta.tone}>{x.host}</Token> to <Token tone={x.env === "production" ? "ask" : "plain"}>{x.env}</Token></span>;
        if (x?.kind === "money") return <span key={r}>{sep}<Token tone={meta.tone}>up to {x.max} {x.currency}</Token></span>;
        return <span key={r}>{sep}<Token tone={meta.tone}>{labelRes(r)}</Token></span>;
      })}
    </span>
  );
}

/** The scope a grant pins, as short chips: the commit, how often, how long, conditions. */
export function ScopeChips({ res, uses, ttl, when }: Pick<ApprovalCardProps, "res" | "uses" | "ttl" | "when">) {
  const chips: string[] = [];
  for (const r of res) {
    const x = parseRes(r);
    if (x?.kind === "github.pr" && x.sha) chips.push(`Only commit ${x.sha.slice(0, 7)}`);
  }
  chips.push(uses === 1 ? "Once" : `Up to ${uses} times`);
  chips.push(`For ${humanDuration(ttl)}`);
  if (when.some((c) => c.c === "checks.pass")) chips.push("Only if checks pass");
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <span key={c} className="rounded-full border bg-background px-2.5 py-1 text-muted-foreground text-xs">{c}</span>
      ))}
    </div>
  );
}

const FIELD: Record<Beyond["field"], string> = { request: "Request", act: "Action", res: "Target", ttl: "Time", uses: "Uses", when: "Condition", aud: "Agent", effect: "Effect", until: "Lasts" };

function Cuts({ cuts }: { cuts: Beyond[] }) {
  if (!cuts.length) return null;
  return (
    <div className="space-y-1.5 text-sm">
      <div className="flex items-center gap-2 font-medium"><ScissorsIcon className="size-4 text-ask" />Left out of this request</div>
      {cuts.map((b, i) => (
        <div key={i} className="grid grid-cols-[72px_1fr] gap-2">
          <span className="text-muted-foreground text-xs leading-6">{FIELD[b.field]}</span>
          <span>
            <s className="text-deny decoration-deny/60">{b.asked.length > 40 ? `${b.asked.slice(0, 38)}…` : b.asked}</s>
            {b.granted ? <> → <strong>{b.granted}</strong></> : " refused"}
            <span className="block text-muted-foreground text-xs">{b.why}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

const who = "font-semibold text-[color-mix(in_oklch,var(--ask)_58%,var(--foreground))]";
const what = "font-semibold text-primary";
const where = "font-semibold underline decoration-dashed decoration-[1.5px] decoration-muted-foreground/55 underline-offset-[5px]";

/** "Allow Assistant to merge PR #182 in adrianmross/okayed?": who in one tone, the verb in another, targets underlined. */
export function ApprovalQuestion({ agent, act, res }: { agent: string; act: string; res: string[] }) {
  const meta = actionMeta(act);
  const targets = res.map((r, i) => {
    const x = parseRes(r);
    const sep = i === 0 ? " " : " and ";
    if (x?.kind === "github.pr") return <span key={r}>{sep}<span className={where}>PR #{x.number}</span> in <span className={where}>{x.owner}/{x.repo}</span></span>;
    if (x?.kind === "site") return <span key={r}>{sep}<span className={where}>{x.host}</span> to <span className={where}>{x.env}</span></span>;
    if (x?.kind === "github.repo") return <span key={r}>{sep}<span className={where}>{x.owner}/{x.repo}</span></span>;
    return <span key={r}>{sep}<span className={where}>{labelRes(r)}</span></span>;
  });
  return (
    <span>
      Allow <span className={who}>{agentName(agent)}</span> to <span className={what}>{meta.verb}</span>
      {targets}?
    </span>
  );
}

/** A payment's amount, from its money resource: "$12.00". */
export function amountOf(res: string[]): string | null {
  const x = res.map(parseRes).find((r) => r?.kind === "money");
  if (!x || x.kind !== "money") return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: x.currency }).format(x.max);
  } catch {
    return `${x.max} ${x.currency}`;
  }
}

const MONEY: Record<ApprovalState, MoneyState> = { pending: "open", approving: "paying", approved: "paid", denied: "declined", expired: "expired" };

/**
 * An approval: where it happens, the question in plain words (who, the verb, the exact targets), the agent's reason
 * under it as their claim, the details a tap away, and one decision. Allowing with Face ID signs a passkey assertion
 * over this exact request, and the permission carries it. A payment is a money card.
 */
export function ApprovalCard(p: ApprovalCardProps) {
  const [more, setMore] = useState(p.detailsOpen ?? false);
  const meta = actionMeta(p.act);
  const flow = p.flow ?? "swipe";
  const pending = p.state === "pending" || p.state === "approving";
  const amount = flow === "swipe" ? amountOf(p.res) : null;

  if (amount) {
    return (
      <div className={cn("w-full max-w-sm space-y-2", p.className)}>
        <MoneyCard
          head={<span className="flex items-center gap-2"><AgentAvatar agent={p.agent} className="size-5 text-[10px]" />{agentName(p.agent)} asks to pay</span>}
          amount={amount}
          what={p.what ?? p.why ?? labelRes(p.res[0]!)}
          method={p.method}
          state={MONEY[p.state]}
          note={p.state === "approved" ? `${p.approvedVia ?? "With Face ID"} · simulated, nothing was charged` : undefined}
          onPay={p.onApprove}
          onDecline={p.onDeny}
        />
      </div>
    );
  }

  const decision =
    p.actions ??
    (flow === "swipe" ? (
      <SwipeDecide
        title={p.state === "approving" ? "Allowing…" : p.passkey === "setup" ? "Swipe to set up Face ID" : "Swipe to allow"}
        label={p.uses === 1 ? "Allow once" : "Allow"}
        busy={p.state === "approving"}
        onAllow={p.onApprove}
        back={{ word: "Deny", onBack: p.onDeny, ...(p.onBlock ? { spans: p.blockSpans ?? BLOCK_SPANS, onSpan: (s: Span) => p.onBlock!(s.seconds ?? null) } : {}) }}
        {...(p.onAlwaysAllow ? { always: { spans: p.alwaysSpans ?? ALWAYS_SPANS, onAlways: (s: Span) => p.onAlwaysAllow!(s.seconds ?? null) } } : {})}
      />
    ) : (
      <ApprovalActions
        layout={p.layout}
        flow={flow}
        passkey={p.passkey}
        uses={p.uses}
        busy={p.state === "approving"}
        onApprove={p.onApprove}
        onApprovePlain={p.onApprovePlain}
        onDeny={p.onDeny}
        onAlwaysAllow={p.onAlwaysAllow}
        onBlock={p.onBlock}
        durations={p.durations}
      />
    ));

  return (
    <div className={cn("relative w-full max-w-md animate-rise rounded-[26px] border bg-card p-5 shadow-sm", !pending && "shadow-none", p.className)}>
      <div className="flex items-center gap-3">
        {p.serviceIcon ?? <ActionTile act={p.act} size="md" className="size-11 rounded-[13px]" />}
        <span className="min-w-0 flex-1 truncate font-semibold text-[17px]">{p.service ?? meta.service}</span>
        {(p.risk === "high" || p.risk === "critical") && <span className="font-medium text-deny text-sm">{p.risk === "critical" ? "Critical" : "High risk"}</span>}
        <Popover>
          <PopoverTrigger className="grid size-8 place-items-center rounded-full text-muted-foreground outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-label="About this request">
            <InfoIcon className="size-5" />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 space-y-3 text-sm">
            <div>
              <div className="font-medium">Your answer</div>
              <p className="text-muted-foreground">
                {p.passkey === "unsupported" ? "Allowing issues one exact, signed permission." : "Face ID signs this exact request, and the permission carries the proof."} It's for {p.uses === 1 ? "one use" : `${p.uses} uses`}, for {humanDuration(p.ttl)}.
              </p>
            </div>
            {p.onAlwaysAllow && flow === "swipe" && (
              <div>
                <div className="font-medium">Always</div>
                <p className="text-muted-foreground">Hold Always (or tap it) to choose how long a rule allows requests like this: a day, 30 days, or until you remove it. Hold Deny to block them the same way.</p>
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>

      <div className="mt-4 font-semibold text-[22px] leading-snug tracking-tight">
        <ApprovalQuestion agent={p.agent} act={p.act} res={p.res} />
      </div>
      {p.why && pending && <p className="mt-2 text-[17px] text-muted-foreground leading-relaxed">{p.why}</p>}

      {pending && (
        <Collapsible open={more} onOpenChange={setMore} className="mt-3">
          <CollapsibleTrigger className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 font-semibold text-muted-foreground text-sm outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
            {more ? "Hide details" : "Details"}
            <ChevronRightIcon className={cn("size-4 motion-safe:transition-transform", more && "rotate-90")} />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-3 rounded-2xl bg-muted/60 p-3">
            <ScopeChips res={p.res} uses={p.uses} ttl={p.ttl} when={p.when} />
            {p.cuts && <Cuts cuts={p.cuts} />}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {p.onApprovePlain && p.passkey !== "unsupported" && flow === "swipe" && (
                <button type="button" className="font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={p.onApprovePlain}>Allow without Face ID</button>
              )}
              {p.onAlwaysAllow && flow === "swipe" && (
                <button type="button" className="font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={() => p.onAlwaysAllow!()}>Make a rule…</button>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      <div className="mt-5">
        {pending ? (
          decision
        ) : (
          <Decided ok={p.state === "approved"}>
            {p.state === "approved" ? (
              <span>
                <span className="font-semibold">Allowed</span>
                <span className="text-muted-foreground"> · {p.approvedVia ?? "with Face ID"}, {p.uses === 1 ? "once" : `${p.uses} uses`}</span>
              </span>
            ) : p.state === "denied" ? (
              <span className="text-muted-foreground">Denied. Nothing was done.</span>
            ) : (
              <span className="text-muted-foreground">Expired before anyone answered.</span>
            )}
          </Decided>
        )}
      </div>
    </div>
  );
}
