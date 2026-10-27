import { ChevronsRightIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { Spinner } from "../ui/spinner";

const KNOB = 56;
const TONES = {
  primary: { track: "bg-primary/10", fill: "bg-primary/20", knob: "bg-primary text-primary-foreground", text: "text-primary" },
  allow: { track: "bg-allow/10", fill: "bg-allow/20", knob: "bg-allow text-white", text: "text-allow" },
  deny: { track: "bg-deny/10", fill: "bg-deny/18", knob: "bg-deny text-white", text: "text-deny" },
} as const;

export interface SlideToConfirmProps {
  /** "Slide to allow" */
  label?: string;
  onConfirm: () => void;
  tone?: keyof typeof TONES;
  /** What the knob shows, e.g. the Face ID glyph. */
  icon?: ReactNode;
  disabled?: boolean;
  /** Working on it: the knob spins and the track stays put. */
  busy?: boolean;
  className?: string;
}

/**
 * Slide to confirm: drag the knob all the way across; let go early and it springs back. With the keyboard, Enter or
 * Space confirms, and the arrows move the knob a quarter at a time.
 */
export function SlideToConfirm({ label = "Slide to allow", onConfirm, tone = "primary", icon, disabled, busy, className }: SlideToConfirmProps) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; id: number; trackPx: number } | null>(null);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);
  const [dragging, setDragging] = useState(false);
  const t = TONES[tone];
  const off = disabled || busy;

  // Once confirmed the knob stays at the end, until the caller is done with it or a moment passes with nothing to show.
  useEffect(() => {
    if (!done || off) return;
    const timer = setTimeout(() => (setDone(false), setProgress(0)), 1500);
    return () => clearTimeout(timer);
  }, [done, off]);

  const confirm = () => {
    drag.current = null;
    setDragging(false);
    setProgress(1);
    setDone(true);
    onConfirm();
  };

  const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    if (off || done || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, id: e.pointerId, trackPx: (track.current?.getBoundingClientRect().width ?? 0) - KNOB - 8 };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const p = Math.min(1, Math.max(0, (e.clientX - d.x) / Math.max(1, d.trackPx)));
    if (p >= 0.97) confirm();
    else setProgress(p);
  };
  const release = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    setProgress(0);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (off || done) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      confirm();
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const p = Math.min(1, Math.max(0, progress + (e.key === "ArrowRight" ? 0.25 : -0.25)));
      if (p >= 1) confirm();
      else setProgress(p);
    } else if (e.key === "Escape") setProgress(0);
  };

  return (
    <div
      ref={track}
      role="button"
      tabIndex={off ? -1 : 0}
      aria-label={label}
      aria-disabled={off || undefined}
      onKeyDown={onKeyDown}
      className={cn(
        "relative h-12 w-full touch-none select-none overflow-hidden rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        t.track,
        off && !busy && "opacity-50",
        className,
      )}
    >
      <div
        className={cn("absolute inset-y-0 left-0", t.fill, !dragging && "motion-safe:transition-[width] motion-safe:duration-300")}
        style={{ width: `calc(${progress} * (100% - ${KNOB + 8}px) + ${KNOB + 8}px)` }}
      />
      <span className={cn("absolute inset-0 flex items-center justify-center pl-14 font-medium text-[15px]", t.text)} style={{ opacity: 1 - progress * 1.4 }}>
        {label}
      </span>
      <span
        data-testid="slide-knob"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerCancel={release}
        className={cn(
          "absolute inset-y-1 grid cursor-grab place-items-center rounded-[10px] shadow-sm active:cursor-grabbing [&_svg]:size-5",
          t.knob,
          !dragging && "motion-safe:transition-[left] motion-safe:duration-300",
        )}
        style={{ width: KNOB, left: `calc(${progress} * (100% - ${KNOB + 8}px) + 4px)` }}
      >
        {busy ? <Spinner /> : (icon ?? <ChevronsRightIcon />)}
      </span>
    </div>
  );
}
