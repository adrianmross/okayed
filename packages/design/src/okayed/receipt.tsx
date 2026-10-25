import { CheckIcon, FileJson2Icon, Undo2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import { ActionTile, AgentAvatar } from "./primitives";

export type ReceiptStatus = "active" | "used" | "expired" | "revoked";

export interface ReceiptCardProps {
  act: string;
  /** "Merged PR #182 in adrianmross/okayed" */
  title: ReactNode;
  agent: string;
  /** "with Face ID", "by your policy “merges go ahead…”" */
  how: string;
  at: number;
  grantId: string;
  used: number;
  uses: number;
  status: ReceiptStatus;
  simulated?: boolean;
  compact?: boolean;
  onShowEvent?: () => void;
  onRevoke?: () => void;
  className?: string;
}

const STATUS: Record<ReceiptStatus, { label: string; cls: string }> = {
  active: { label: "Live", cls: "bg-allow/14 text-allow" },
  used: { label: "Used", cls: "bg-muted text-muted-foreground" },
  expired: { label: "Expired", cls: "bg-muted text-muted-foreground" },
  revoked: { label: "Revoked", cls: "bg-deny/12 text-deny" },
};

function when(t: number): string {
  return new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** A receipt for one grant: what it allowed, who, how you okayed it, and whether it's still live. */
export function ReceiptCard(p: ReceiptCardProps) {
  return (
    <div className={cn("relative w-full overflow-hidden rounded-2xl border bg-card", p.compact ? "max-w-md" : "", p.className)}>
      <div className="border-b border-dashed px-4 py-3">
        <div className="flex items-start gap-3">
          <ActionTile act={p.act} size={p.compact ? "sm" : "md"} />
          <div className="min-w-0 flex-1">
            <div className="font-semibold leading-snug">{p.title}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-sm">
              <AgentAvatar agent={p.agent} className="size-4 text-[9px]" />
              <span>{p.agent.replace(/^agent:/, "")}</span>
              <span aria-hidden="true">·</span>
              <span>{p.how}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular">{when(p.at)}</span>
            </div>
          </div>
          <Badge variant="secondary" className={cn("rounded-full", STATUS[p.status].cls)}>{STATUS[p.status].label}</Badge>
        </div>
      </div>
      <div className="flex items-center gap-3 px-4 py-2.5 text-xs">
        <span className="inline-flex items-center gap-1 text-muted-foreground"><CheckIcon className="size-3.5 text-allow" />{p.used} of {p.uses} {p.uses === 1 ? "use" : "uses"}</span>
        <span className="truncate font-mono text-muted-foreground">grant {p.grantId.slice(0, 10)}</span>
        {p.simulated && <span className="text-muted-foreground">· simulated</span>}
        <span className="ml-auto flex gap-1">
          {p.onShowEvent && <Button size="xs" variant="ghost" onClick={p.onShowEvent}><FileJson2Icon />Signed event</Button>}
          {p.onRevoke && p.status === "active" && <Button size="xs" variant="ghost" className="text-deny" onClick={p.onRevoke}><Undo2Icon />Revoke</Button>}
        </span>
      </div>
    </div>
  );
}
