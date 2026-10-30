import { XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/**
 * Done, settled: the disc fades in, then the tick draws itself left to right, with no bounce. A no only fades in:
 * nothing to celebrate there. Under reduced motion it's drawn at once.
 */
export function DoneMark({ ok, className }: { ok: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "inline-grid size-7 shrink-0 place-items-center rounded-full motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150",
        ok ? "bg-allow text-white" : "bg-muted-foreground/70 text-background",
        className,
      )}
      aria-hidden="true"
    >
      {ok ? (
        <svg viewBox="0 0 24 24" className="size-[62%]">
          <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" pathLength={1} className="okayed-tick" />
        </svg>
      ) : (
        <XIcon className="size-[56%]" strokeWidth={2.6} />
      )}
    </span>
  );
}

/** What was decided: the mark settling in, and the words. */
export function Decided({ ok, children, className }: { ok: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-3 text-[15px]", className)}>
      <DoneMark ok={ok} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
