import { BanIcon, CheckIcon, RepeatIcon, ScanFaceIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { cn } from "../lib/utils";
import { HOLD_DURATIONS, HoldSlide, type HoldStep } from "./hold-slide";
import { SlideToConfirm } from "./slide";

/** "stack": the main decision full width, the others under it. "row": Don't allow · Always allow… · Allow once. */
export type ApprovalLayout = "stack" | "row";
/** "tap": buttons. "swipe": slide to allow. "hold": hold and slide to pick how long Always allow… or Block… lasts. */
export type ApprovalFlow = "tap" | "swipe" | "hold";

export interface ApprovalActionsProps {
  layout?: ApprovalLayout;
  flow?: ApprovalFlow;
  /** "ready": allow with Face ID; "setup": offer to set it up first; "unsupported": a plain tap. */
  passkey: "ready" | "setup" | "unsupported";
  /** How many uses the permission has: one reads "Allow once". */
  uses: number;
  /** Allowing is under way. */
  busy?: boolean;
  onApprove: () => void;
  /** Allow without Face ID, where the browser could use it. */
  onApprovePlain?: () => void;
  onDeny: () => void;
  /**
   * "Always allow…". With no argument: open the rule editor. From a hold-and-slide: how long the rule lasts, in
   * seconds, or `null` for a rule that doesn't end.
   */
  onAlwaysAllow?: (forSeconds?: number | null) => void;
  /** "Block…": the same, for a rule that blocks requests like this one. */
  onBlock?: (forSeconds?: number | null) => void;
  /** The ladder a hold-and-slide climbs. */
  durations?: HoldStep[];
  className?: string;
}

/**
 * The decision area of an approval card, in any of its configurations. Implementations pick a layout and a flow, or
 * build their own from `SlideToConfirm` and `HoldSlide`.
 */
export function ApprovalActions({ layout = "stack", flow = "tap", passkey, uses, busy, onApprove, onApprovePlain, onDeny, onAlwaysAllow, onBlock, durations = HOLD_DURATIONS, className }: ApprovalActionsProps) {
  const glyph = passkey === "unsupported" ? <CheckIcon className="size-5" /> : <ScanFaceIcon className="size-5" />;
  const allowLabel = passkey === "setup" ? "Set up Face ID and allow" : uses === 1 ? "Allow once" : "Allow";
  const row = layout === "row";

  const primary: ReactNode =
    flow === "swipe" ? (
      <SlideToConfirm label={passkey === "setup" ? "Slide to set up and allow" : "Slide to allow"} icon={glyph} busy={busy} onConfirm={onApprove} />
    ) : (
      <Button size="lg" className={cn("h-12 gap-2 rounded-xl text-[15px]", row ? "flex-1" : "w-full")} disabled={busy} onClick={onApprove}>
        {busy ? <Spinner /> : glyph}
        {allowLabel}
      </Button>
    );

  const secondary = (label: string, icon: ReactNode, tone: "allow" | "deny", verb: string, on?: (s?: number | null) => void) =>
    !on ? null : flow === "hold" ? (
      <HoldSlide key={label} label={label} verb={verb} tone={tone} icon={icon} steps={durations} disabled={busy} expand onTap={() => on()} onConfirm={(s) => on(s.seconds)} className={row ? "shrink-0" : undefined} />
    ) : (
      <Button key={label} variant="outline" className="rounded-xl" disabled={busy} onClick={() => on()}>
        {icon}
        {label}
      </Button>
    );

  const always = secondary("Always allow…", <RepeatIcon />, "allow", "allow", onAlwaysAllow);
  const block = secondary("Block…", <BanIcon />, "deny", "block", onBlock);
  const deny = (
    <Button key="deny" variant="ghost" className="rounded-xl text-muted-foreground" disabled={busy} onClick={onDeny}>
      Don't allow
    </Button>
  );
  const plain = onApprovePlain && passkey !== "unsupported" && (
    <Button variant="link" size="sm" className="w-full text-muted-foreground" disabled={busy} onClick={onApprovePlain}>
      Allow without Face ID
    </Button>
  );

  if (row) {
    return (
      <div className={cn("space-y-2", className)}>
        <div className="relative flex flex-wrap items-center gap-2">
          {deny}
          {block}
          {always}
          <div className="flex min-w-40 flex-1">{primary}</div>
        </div>
        {plain}
      </div>
    );
  }
  const others = [always, block, deny].filter(Boolean);
  return (
    <div className={cn("space-y-2", className)}>
      {primary}
      <div className={cn("relative grid gap-2", others.length === 3 ? "grid-cols-3" : "grid-cols-2")}>
        {others.length === 1 && <span />}
        {others}
      </div>
      {plain}
    </div>
  );
}
