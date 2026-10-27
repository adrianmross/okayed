import { humanDuration, labelRes, parseRes, type Beyond, type Condition, type Risk } from "@okayed/engine";
import { ChevronRightIcon, ScissorsIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "../ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "../lib/utils";
import { actionMeta } from "./actions";
import { ApprovalActions, type ApprovalFlow, type ApprovalLayout } from "./approval-actions";
import type { HoldStep } from "./hold-slide";
import { ActionTile, AgentAvatar, Seal, Token, agentName } from "./primitives";

export type ApprovalState = "pending" | "approving" | "approved" | "denied" | "expired";

export interface ApprovalCardProps {
  agent: string;
  act: string;
  res: string[];
  uses: number;
  ttl: number;
  when: Condition[];
  risk: Risk;
  why?: string;
  cuts?: Beyond[];
  state: ApprovalState;
  /** "ready": allow with Face ID; "setup": offer to set it up first; "unsupported": a plain tap. */
  passkey: "ready" | "setup" | "unsupported";
  approvedVia?: string;
  onApprove: () => void;
  onApprovePlain?: () => void;
  /** "Always allow…": with no argument, open the rule editor; from a hold-and-slide, seconds (null: no end). */
  onAlwaysAllow?: (forSeconds?: number | null) => void;
  /** "Block…": the same, for a rule that blocks requests like this one. */
  onBlock?: (forSeconds?: number | null) => void;
  onDeny: () => void;
  /** How the decisions are laid out and how they're made. Defaults: "stack" and "tap". */
  layout?: ApprovalLayout;
  flow?: ApprovalFlow;
  /** The ladder for a hold-and-slide. */
  durations?: HoldStep[];
  /** Replaces the decision area entirely, for implementations that build their own. */
  actions?: ReactNode;
  className?: string;
}

const RISK: Record<Risk, string> = { low: "Low risk", medium: "Medium risk", high: "High risk", critical: "Critical" };

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
  const [open, setOpen] = useState(false);
  if (!cuts.length) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl bg-muted/60">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm">
        <ScissorsIcon className="size-4 text-ask" />
        <span className="flex-1">Left out of this request <span className="text-muted-foreground">· {cuts.length}</span></span>
        <ChevronRightIcon className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-1.5 px-3 pb-3 text-sm">
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
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The approval card: who wants to do exactly what, within which scope, and one decision. Allowing with Face ID
 * signs a passkey assertion over this exact request, and the permission carries it.
 */
export function ApprovalCard(p: ApprovalCardProps) {
  const done = p.state === "approved" || p.state === "denied" || p.state === "expired";
  return (
    <div className={cn("relative w-full max-w-md animate-rise overflow-hidden rounded-2xl border bg-card shadow-sm", done && "shadow-none", p.className)}>
      <div className="flex items-center gap-2 px-4 pt-4 text-muted-foreground text-sm">
        <AgentAvatar agent={p.agent} className="size-6 text-xs" />
        <span><span className="font-medium text-foreground">{agentName(p.agent)}</span> wants to</span>
        <Badge variant="secondary" className={cn("ml-auto rounded-full", (p.risk === "high" || p.risk === "critical") && "bg-deny/12 text-deny")}>{RISK[p.risk]}</Badge>
      </div>
      <div className="flex items-start gap-3 px-4 pt-3">
        <ActionTile act={p.act} size="lg" />
        <div className="min-w-0 pt-1 font-semibold text-[17px] leading-8">
          <ActionSentence act={p.act} res={p.res} />
        </div>
      </div>
      {p.why && <p className="px-4 pt-2 text-muted-foreground text-sm">“{p.why}”</p>}
      <div className="space-y-3 px-4 pt-3">
        <ScopeChips res={p.res} uses={p.uses} ttl={p.ttl} when={p.when} />
        {p.cuts && <Cuts cuts={p.cuts} />}
      </div>
      <div className="p-4">
        {p.state === "pending" || p.state === "approving" ? (
          (p.actions ?? (
            <ApprovalActions
              layout={p.layout}
              flow={p.flow}
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
          ))
        ) : p.state === "approved" ? (
          <div className="flex items-center gap-3">
            <Seal className="size-12 [&_svg]:size-10" />
            <div className="text-sm">
              <div className="font-semibold">Okayed</div>
              <div className="text-muted-foreground">{p.approvedVia ?? "With Face ID"} · {p.uses === 1 ? "a one-time permission" : `a permission for ${p.uses} uses`}, signed</div>
            </div>
          </div>
        ) : (
          <div className="text-muted-foreground text-sm">{p.state === "denied" ? "You said no. Nothing was done." : "This request expired before anyone answered."}</div>
        )}
      </div>
    </div>
  );
}
