import { ChevronsRightIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { Token } from "./primitives";

/** One rung of the ladder: how long a rule made by a hold-and-slide lasts. `seconds: null` means it doesn't end. */
export interface HoldStep {
  label: string;
  seconds: number | null;
}

export const HOLD_DURATIONS: HoldStep[] = [
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "1 week", seconds: 7 * 86400 },
  { label: "30 days", seconds: 30 * 86400 },
  { label: "Always", seconds: null },
];

export interface HoldSlideState {
  step: number;
  /** 0 to 1: how far along the track. */
  progress: number;
  /** Set once the swipe is under way, so moving sideways can't change the step. */
  locked: boolean;
}

export const HOLD_IDLE: HoldSlideState = { step: 0, progress: 0, locked: false };

/** How far along the track counts as all the way. */
export const HOLD_END = 0.96;

/**
 * Where a hold-and-slide is, from how far the pointer has moved since the press: every `stepPx` up is one rung
 * longer, and moving right fills the track. Past `lockAt` the rung stays put. Pure, so it's easy to test and reuse.
 */
export function readHoldSlide(prev: HoldSlideState, dx: number, dy: number, o: { count: number; trackPx: number; stepPx?: number; lockAt?: number }): HoldSlideState {
  const progress = Math.min(1, Math.max(0, dx / Math.max(1, o.trackPx)));
  const locked = prev.locked || progress >= (o.lockAt ?? 0.12);
  const step = locked ? prev.step : Math.min(o.count - 1, Math.floor(Math.max(0, -dy) / (o.stepPx ?? 28)));
  return { step, progress, locked };
}

const KNOB = 40;
const TONES = {
  allow: { fill: "bg-allow/16", knob: "bg-allow", text: "text-allow" },
  deny: { fill: "bg-deny/14", knob: "bg-deny", text: "text-deny" },
} as const;

export interface HoldSlideProps {
  /** The button: "Always allow…", "Block…". */
  label: string;
  /** The track: "allow" reads "Slide to allow · 1 week". */
  verb: string;
  tone?: keyof typeof TONES;
  icon?: ReactNode;
  steps?: HoldStep[];
  /** A plain tap, with no duration: open the rule editor, say. */
  onTap?: () => void;
  /** Slid all the way, with the rung it was on. */
  onConfirm: (step: HoldStep) => void;
  disabled?: boolean;
  /** Let the track cover the nearest positioned ancestor (a whole row of actions) rather than just this button. */
  expand?: boolean;
  className?: string;
}

/**
 * Press and hold, slide up to pick how long, then slide all the way across to confirm; let go early and nothing
 * happens. A tap is just a tap. With the keyboard: arrows up and down pick the rung, Enter confirms, Escape cancels.
 */
export function HoldSlide({ label, verb, tone = "allow", icon, steps = HOLD_DURATIONS, onTap, onConfirm, disabled, expand, className }: HoldSlideProps) {
  const hint = useId();
  const drag = useRef<{ x: number; y: number; id: number; trackPx: number; moved: boolean; timer: number } | null>(null);
  const state = useRef<HoldSlideState>(HOLD_IDLE);
  const [s, setS] = useState<HoldSlideState>(HOLD_IDLE);
  const [armed, setArmed] = useState(false);
  const t = TONES[tone];

  const put = (next: HoldSlideState) => {
    state.current = next;
    setS(next);
  };
  const reset = () => {
    if (drag.current) clearTimeout(drag.current.timer);
    drag.current = null;
    setArmed(false);
    put(HOLD_IDLE);
  };
  const confirm = (step: number) => {
    const chosen = steps[step];
    reset();
    if (chosen) onConfirm(chosen);
  };
  useEffect(() => () => clearTimeout(drag.current?.timer), []);

  // The track spans the area's width, on the button's own line (a wrapped row of actions has more than one).
  const [top, setTop] = useState(0);
  const measure = (b: HTMLButtonElement) => {
    setTop(expand ? b.offsetTop : 0);
    return ((expand ? b.offsetParent : b.parentElement) ?? b).getBoundingClientRect().width - KNOB;
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (disabled || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const trackPx = measure(e.currentTarget);
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId, trackPx, moved: false, timer: window.setTimeout(() => setArmed(true), 180) };
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 6) return;
    d.moved = true;
    setArmed(true);
    const next = readHoldSlide(state.current, dx, dy, { count: steps.length, trackPx: d.trackPx });
    if (next.progress >= HOLD_END) confirm(next.step);
    else put(next);
  };
  const onPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    // A quick press that never moved is a tap; anything else let go early is a change of mind.
    const tap = !d.moved && !armed;
    reset();
    if (tap) onTap?.();
  };
  // Keyboard presses arrive as clicks with no pointer behind them.
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (e.detail === 0 && !armed) onTap?.();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const cur = state.current;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const step = !armed ? 0 : Math.min(steps.length - 1, Math.max(0, cur.step + (e.key === "ArrowUp" ? 1 : -1)));
      if (!armed) measure(e.currentTarget);
      setArmed(true);
      put({ ...cur, step });
    } else if ((e.key === "Enter" || e.key === " ") && armed) {
      e.preventDefault();
      confirm(cur.step);
    } else if (e.key === "Escape" && armed) {
      e.preventDefault();
      reset();
    }
  };

  const step = steps[s.step] ?? steps[0]!;
  return (
    <div className={cn(!expand && "relative", "min-w-0", className)}>
      <button
        type="button"
        disabled={disabled}
        aria-describedby={hint}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={reset}
        onLostPointerCapture={() => drag.current && reset()}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onBlur={() => armed && reset()}
        className="inline-flex h-10 w-full touch-none select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl border bg-background px-3 font-medium text-sm shadow-xs outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0"
      >
        {icon}
        {label}
      </button>
      <span id={hint} className="sr-only">
        Tap for more choices. Or press and hold, slide up to pick how long, then slide right to confirm. With the keyboard, use the up and down arrows, then Enter.
      </span>
      <span aria-live="polite" className="sr-only">{armed ? `${label.replace(/…$/, "")} for ${step.label.toLowerCase()}` : ""}</span>
      {armed && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 z-10 h-10" style={{ top }} data-testid="hold-slide-track">
          <div className="relative h-full w-full rounded-xl border bg-card shadow-sm">
            <div className="absolute bottom-full left-0 mb-2 flex flex-col-reverse gap-0.5 rounded-xl border bg-popover p-1 shadow-md">
              {steps.map((x, i) => (
                <span key={x.label} className={cn("rounded-md px-2 py-0.5 font-medium text-xs", i === s.step ? cn(t.fill, t.text) : "text-muted-foreground")}>
                  {x.label}
                </span>
              ))}
            </div>
            <div className="relative h-full overflow-hidden rounded-xl">
              <div className={cn("absolute inset-y-0 left-0", t.fill)} style={{ width: `calc(${s.progress} * (100% - ${KNOB}px) + ${KNOB}px)` }} />
              <span className="absolute inset-0 flex items-center justify-center gap-1 pl-10 text-sm" style={{ opacity: 1 - s.progress * 0.8 }}>
                Slide to {verb}
                <Token tone={tone}>{step.label}</Token>
              </span>
              <span
                className={cn("absolute inset-y-1 grid w-8 place-items-center rounded-lg text-white shadow-sm [&_svg]:size-4", t.knob)}
                style={{ left: `calc(${s.progress} * (100% - ${KNOB}px) + 4px)` }}
              >
                <ChevronsRightIcon />
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
