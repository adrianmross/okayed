import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/utils";
import { actionMeta, type Tone } from "./actions";

const TILE_SIZES = { sm: "size-7 rounded-[9px] [&_svg]:size-3.5", md: "size-10 rounded-xl [&_svg]:size-5", lg: "size-14 rounded-2xl [&_svg]:size-7" };

/** A Shortcuts-style gradient tile with the action's icon. */
export function ActionTile({ act, tone, icon, size = "md", className }: { act?: string; tone?: Tone; icon?: ReactNode; size?: keyof typeof TILE_SIZES; className?: string }) {
  const meta = actionMeta(act ?? "*");
  const Icon = meta.icon;
  return (
    <span data-tone={tone ?? meta.tone} className={cn("okayed-tile inline-grid shrink-0 place-items-center shadow-sm shadow-black/10", TILE_SIZES[size], className)} aria-hidden="true">
      {icon ?? <Icon strokeWidth={2.2} />}
    </span>
  );
}

const AGENT_HUES = [266, 200, 150, 30, 330, 90];

/** An agent's round badge: its initial on a hue derived from its name. */
export function AgentAvatar({ agent, className }: { agent: string; className?: string }) {
  const name = agent.replace(/^agent:/, "");
  const hue = AGENT_HUES[[...name].reduce((h, c) => h + c.charCodeAt(0), 0) % AGENT_HUES.length];
  return (
    <span
      className={cn("inline-grid size-7 shrink-0 place-items-center rounded-full font-semibold text-[13px] text-white", className)}
      style={{ background: `linear-gradient(145deg, oklch(0.7 0.13 ${hue}), oklch(0.55 0.15 ${hue}))` }}
      aria-hidden="true"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const TOKEN_TONES: Record<Tone | "allow" | "ask" | "deny" | "plain", string> = {
  read: "bg-[color-mix(in_oklch,var(--tile-read-to)_14%,transparent)] text-[var(--tile-read-to)] dark:text-[var(--tile-read-from)]",
  comment: "bg-[color-mix(in_oklch,var(--tile-comment-to)_14%,transparent)] text-[var(--tile-comment-to)] dark:text-[var(--tile-comment-from)]",
  merge: "bg-[color-mix(in_oklch,var(--tile-merge-to)_14%,transparent)] text-[var(--tile-merge-to)] dark:text-[var(--tile-merge-from)]",
  deploy: "bg-[color-mix(in_oklch,var(--tile-deploy-to)_14%,transparent)] text-[var(--tile-deploy-to)] dark:text-[var(--tile-deploy-from)]",
  spend: "bg-[color-mix(in_oklch,var(--tile-spend-to)_14%,transparent)] text-[var(--tile-spend-to)] dark:text-[var(--tile-spend-from)]",
  policy: "bg-primary/12 text-primary",
  any: "bg-muted text-foreground",
  allow: "bg-allow/14 text-allow",
  ask: "bg-ask/18 text-[color-mix(in_oklch,var(--ask)_70%,var(--foreground))]",
  deny: "bg-deny/12 text-deny",
  plain: "bg-muted text-foreground",
};

export type TokenTone = keyof typeof TOKEN_TONES;

/**
 * A value inside a sentence, as Shortcuts shows variables: tinted, bold, and tappable when it can change.
 * Render inside text; pass `onClick` (or use as a popover trigger via `asButton`) to make it interactive.
 */
export function Token({ tone = "plain", children, className, interactive, ...props }: ComponentProps<"button"> & { tone?: TokenTone; interactive?: boolean }) {
  const cls = cn(
    "mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 align-baseline font-semibold leading-snug",
    TOKEN_TONES[tone],
    interactive && "cursor-pointer outline-none transition hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring",
    className,
  );
  if (!interactive && !props.onClick) return <span className={cls}>{children}</span>;
  return (
    <button type="button" className={cls} {...props}>
      <span className="truncate">{children}</span>
      <ChevronDownIcon className="size-3 opacity-60" />
    </button>
  );
}

/** The okayed seal: pressed onto something you approved. */
export function Seal({ className, label = "Okayed" }: { className?: string; label?: string }) {
  return (
    <span className={cn("inline-grid size-16 animate-seal place-items-center rounded-full border-[3px] border-seal text-seal", className)} role="img" aria-label={label}>
      <svg viewBox="0 0 48 48" className="size-14" aria-hidden="true">
        <circle cx="24" cy="24" r="19" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2.6" />
        <path d="M15 24.5l6 6L33.5 18" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

const VERDICT = { allow: { label: "Goes ahead", cls: "bg-allow/14 text-allow" }, ask: { label: "Asks you", cls: "bg-ask/18 text-[color-mix(in_oklch,var(--ask)_70%,var(--foreground))]" }, deny: { label: "Never", cls: "bg-deny/12 text-deny" } } as const;

export function VerdictPill({ verdict, children, className }: { verdict: keyof typeof VERDICT; children?: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-xs", VERDICT[verdict].cls, className)}>{children ?? VERDICT[verdict].label}</span>;
}

/** A Shortcuts editor block: an icon on the left, a sentence of tokens on the right, stacked into a flow. */
export function Step({ icon, children, className, ...props }: ComponentProps<"div"> & { icon: ReactNode }) {
  return (
    <div className={cn("relative flex items-start gap-3 rounded-2xl border bg-card p-3.5 shadow-xs", className)} {...props}>
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1 text-[15px] leading-8">{children}</div>
    </div>
  );
}

/** The thin connector between Steps. */
export const StepJoin = () => <div className="ml-[30px] h-3 w-0.5 rounded bg-border" aria-hidden="true" />;
