import { ChevronLeftIcon, ChevronRightIcon, RepeatIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { Spinner } from "../ui/spinner";
import {
  ARMED_MS, CHIP_H, DWELL_MS, HOLD_MS, KNOB, PAD, chipsOf, holdCommits, holdDwell, holdHome, holdMove, holdStart, knobMax, letGo, slide, tapBack,
  type Hold, type Mode, type Rect,
} from "./swipe-model";

/** How long something decided lasts: an Always rule, or a block. */
export interface Span {
  id: string;
  /** In full ("For 30 days"): the tapped choices, and what a screen reader says. */
  words: string;
  /** Its chip while held: a few letters ("30d", "∞") or a glyph (`icon`). */
  short?: string;
  icon?: ReactNode;
  /** What the track says once it's picked ("Swipe to allow for 30 days"). */
  says?: string;
  /** How long, in seconds; `null` until removed. */
  seconds?: number | null;
}

export const ALWAYS_SPANS: Span[] = [
  { id: "day", words: "For a day", short: "1d", seconds: 86400, says: "Swipe to allow for a day" },
  { id: "month", words: "For 30 days", short: "30d", seconds: 30 * 86400, says: "Swipe to allow for 30 days" },
  { id: "forever", words: "Until you remove it", short: "∞", seconds: null, says: "Swipe to always allow" },
];

export const BLOCK_SPANS: Span[] = [
  { id: "day", words: "For a day", short: "1d", seconds: 86400, says: "Swipe to block for a day" },
  { id: "month", words: "For 30 days", short: "30d", seconds: 30 * 86400, says: "Swipe to block for 30 days" },
  { id: "forever", words: "Until you remove it", short: "∞", seconds: null, says: "Swipe to always block" },
];

export interface SwipeDecideProps {
  /** The right swipe's words: "Swipe to allow", "Swipe to pay". */
  title?: string;
  /** What a screen reader calls the right swipe, where the title needs more ("Pay $12.00"). */
  label?: string;
  /** The right swipe's answer. Without it the track only swipes left. */
  onAllow?: () => void;
  /**
   * The other answer ("Deny", "Not now"): a pill under the track on a card with Always, else a button at the row's
   * right end. `spans`, on a card: held, Deny offers them too, to block requests like this for that long.
   */
  back?: { word: string; onBack: () => void; swipe?: string; spans?: Span[]; onSpan?: (span: Span) => void };
  /** Always, for how long: held (a chip to rest on) or tapped (the spans in the pills' place). `off`: shown, not offered. */
  always?: { spans: Span[]; onAlways: (span: Span) => void; off?: boolean; word?: string };
  /** The knob's glyph on a right swipe; a chevron by default. */
  knob?: ReactNode;
  disabled?: boolean;
  /** Working on a decision (Face ID, then signing): the knob stays where it was swiped, with a spinner, until it ends. */
  busy?: boolean;
  /** On a dark card (money): a glass track and a white knob. */
  light?: boolean;
  className?: string;
}

/** Between the pills, and between them and the track. */
const GAP = 8;
const TRACK_H = KNOB + PAD * 2;

const relTo = (root: HTMLElement, el: HTMLElement): Rect => {
  const a = root.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  return { x: b.left - a.left, y: b.top - a.top, w: b.width, h: b.height };
};

/**
 * Swipe to decide: every approval's one gesture. The answer it names ("Swipe to allow", "Swipe to pay") is a swipe
 * right; the other answer is never a plain swipe or a tap, so neither is given by accident.
 *
 * With Always, Always and Deny are pills under the track:
 * - Hold Always: its spans pop up as chips between the pills and the track. Slide up onto one and rest there (passing
 *   over one picks nothing): it lights, and the track says what it will do ("Swipe to allow for 30 days"). Then on up
 *   into the track by the knob, and swipe right. Lifted early anywhere: nothing.
 * - Hold Deny: the track turns red with its knob at the end; slide into the track there and swipe left. With block
 *   spans, rest on one on the way to block requests like this for that long.
 * - Tap Deny: the same red track, to swipe left the full length; Deny reads Cancel while armed, and a few seconds
 *   with nothing done disarm it. Tap Always: its spans in the pills' place, to tap, then swipe.
 *
 * Without Always, the other answer is a button at the row's right end ("Not now"), and both answers are full-length
 * swipes: swipe the track and it grows over Not now; hold Not now and its bar takes the row, to slide left; tap it and
 * the bar waits for a left swipe. With the keyboard: Enter on the track answers what it says; the pills are buttons.
 */
export function SwipeDecide({ title = "Swipe to allow", label, onAllow, back, always, knob: glyph, disabled, busy, light, className }: SwipeDecideProps) {
  const root = useRef<HTMLDivElement>(null);
  const trackEl = useRef<HTMLDivElement>(null);
  const pillsEl = useRef<HTMLDivElement>(null);
  const asideEl = useRef<HTMLButtonElement>(null);
  const [w, setW] = useState(0);
  const [asideW, setAsideW] = useState(0);
  const max = knobMax(w);
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  /** A single row's track grown over Not now (a swipe under way). */
  const [wide, setWide] = useState(false);
  const [armed, setArmed] = useState<Mode>("allow");
  const [span, setSpan] = useState(0);
  const [holding, setHolding] = useState<{ kind: Hold["kind"]; picked: number; chips: Rect[] } | null>(null);
  const [asideHeld, setAsideHeld] = useState(false);
  const [nudge, setNudge] = useState(false);

  const spans = always?.spans ?? [];
  const blocks = (always && back?.spans) || [];
  const single = !!back && !always;
  const locked = disabled || busy;
  const canBack = !!back && !locked;
  const canAlways = !!always && !always.off && spans.length > 0 && !locked;
  const mode: Mode = holding?.kind ?? (asideHeld ? "deny" : armed);
  const canRight = !locked && (mode === "allow" ? !!onAllow : mode === "deny" ? canBack : canAlways);
  const fromEnd = mode === "deny";
  const full = single || fromEnd;

  useLayoutEffect(() => {
    const el = trackEl.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.getBoundingClientRect().width));
    ro.observe(el);
    setW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (asideEl.current) setAsideW(asideEl.current.getBoundingClientRect().width);
  }, [back?.word, single]);

  // The latest props, for handlers that outlive a render.
  const now = useRef({ onAllow, back, always, armed, span, max, busy });
  now.current = { onAllow, back, always, armed, span, max, busy };

  const arm = useCallback((m: Mode) => {
    setArmed(m);
    setX(m === "deny" ? now.current.max : 0);
  }, []);
  const settle = useRef<number | undefined>(undefined);
  const decide = useCallback((m: Mode, picked: number) => {
    const p = now.current;
    navigator.vibrate?.(12);
    if (m === "allow") p.onAllow?.();
    else if (m === "deny") {
      const s = picked >= 0 ? p.back?.spans?.[picked] : undefined;
      if (s && p.back?.onSpan) p.back.onSpan(s);
      else p.back?.onBack();
    } else {
      const s = p.always?.spans[picked];
      if (s) p.always!.onAlways(s);
    }
    // The track keeps saying what was decided until it settles.
    setArmed(m);
    if (m === "always") setSpan(picked);
    clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      if (now.current.busy) return;
      setX(0);
      setWide(false);
      setArmed("allow");
    }, 700);
  }, []);
  useEffect(() => () => clearTimeout(settle.current), []);
  // When the work ends without a decision (Face ID cancelled, signing failed), the knob goes home.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      setX(0);
      setWide(false);
      setArmed("allow");
    }
    wasBusy.current = !!busy;
  }, [busy]);

  // A tapped Deny goes back to Allow when nothing is done with it for a while (never mid-swipe).
  useEffect(() => {
    if (armed !== "deny" || dragging || holding || asideHeld) return;
    const t = setTimeout(() => arm("allow"), ARMED_MS);
    return () => clearTimeout(t);
  }, [armed, dragging, holding, asideHeld, arm]);

  // ---------- the track: a swipe ----------
  const swipe = useRef<{ id: number; x0: number; home: number; moved: boolean } | null>(null);
  const onTrackDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!canRight || max <= 0 || e.button !== 0 || holding) return;
    if (asideEl.current?.contains(e.target as Node)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    swipe.current = { id: e.pointerId, x0: e.clientX, home: fromEnd ? max : 0, moved: false };
  };
  const onTrackMove = (e: PointerEvent<HTMLDivElement>) => {
    const s = swipe.current;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x0;
    if (!s.moved && Math.abs(dx) < 6) return;
    if (!s.moved) {
      s.moved = true;
      setDragging(true);
      if (single && !fromEnd) setWide(true);
    }
    setX(slide(s.home, dx, max));
  };
  const onTrackUp = (e: PointerEvent<HTMLDivElement>) => {
    const s = swipe.current;
    if (!s || s.id !== e.pointerId) return;
    swipe.current = null;
    setDragging(false);
    if (!s.moved) {
      // A tap is never an answer: an armed Deny goes back; otherwise the knob nudges to show it moves.
      if (fromEnd) arm("allow");
      else {
        setNudge(true);
        setTimeout(() => setNudge(false), 260);
      }
      return;
    }
    const r = letGo(x, max, s.home, full);
    setX(r.to);
    if (r.done) decide(mode, mode === "always" ? span : -1);
    else if (single) setWide(false);
  };
  const onTrackCancel = () => {
    if (!swipe.current) return;
    setX(swipe.current.home);
    swipe.current = null;
    setDragging(false);
    setWide(false);
  };
  const onTrackKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && armed !== "allow") {
      e.preventDefault();
      arm("allow");
    } else if ((e.key === "Enter" || e.key === " ") && canRight) {
      // A key press is deliberate, unlike a stray touch: it answers what the track says.
      e.preventDefault();
      setX(fromEnd ? 0 : max);
      decide(mode, mode === "always" ? span : -1);
    }
  };

  // ---------- the pills: a hold, or a tap ----------
  const press = useRef<{ id: number; kind: Hold["kind"]; x0: number; y0: number; timer: number; held: boolean; gone: boolean; hold?: Hold; chips?: Rect[]; dwell?: number } | null>(null);
  const spansOf = (kind: Hold["kind"]) => (kind === "always" ? spans : blocks);
  const point = (e: PointerEvent) => {
    const a = root.current!.getBoundingClientRect();
    return [e.clientX - a.left, e.clientY - a.top] as const;
  };
  const tapPill = (kind: Hold["kind"]) => {
    if (kind === "always") {
      setSpan(0);
      setArmed("always");
      setX(0);
    } else arm(tapBack(now.current.armed));
  };
  const onPillDown = (kind: Hold["kind"]) => (e: PointerEvent<HTMLButtonElement>) => {
    if ((kind === "always" ? !canAlways : !canBack) || e.button !== 0 || max <= 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = { id: e.pointerId, kind, x0: e.clientX, y0: e.clientY, timer: 0, held: false, gone: false } as NonNullable<typeof press.current>;
    p.timer = window.setTimeout(() => {
      if (press.current !== p || p.gone) return;
      const track = relTo(root.current!, trackEl.current!);
      const pills = relTo(root.current!, pillsEl.current!);
      const n = spansOf(kind).length;
      const cx = kind === "always" ? pills.x + (pills.w - GAP) / 4 : pills.x + pills.w - (pills.w - GAP) / 4;
      const chips = chipsOf(track, n, cx, (track.y + track.h + pills.y) / 2);
      p.held = true;
      p.hold = holdStart(kind, n);
      p.chips = chips;
      navigator.vibrate?.(8);
      setArmed("allow");
      setX(holdHome(kind, knobMax(track.w)));
      setHolding({ kind, picked: p.hold.picked, chips });
    }, HOLD_MS);
    press.current = p;
  };
  const onPillMove = (e: PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    if (!p.held) {
      // Moving off before the hold starts is neither a hold nor a tap.
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 10) p.gone = true;
      return;
    }
    const track = relTo(root.current!, trackEl.current!);
    const [px, py] = point(e);
    const next = holdMove(p.hold!, px, py, track, p.chips ?? [], performance.now());
    if (next.over >= 0 && next.over !== p.hold!.over) {
      // A still finger sends no more moves: look again once it could have rested there.
      clearTimeout(p.dwell);
      p.dwell = window.setTimeout(() => {
        if (press.current !== p || !p.hold) return;
        const d = holdDwell(p.hold, performance.now());
        if (d.picked !== p.hold.picked) {
          p.hold = d;
          navigator.vibrate?.(6);
          setHolding((h) => (h ? { ...h, picked: d.picked } : h));
        }
      }, DWELL_MS + 20);
    }
    if (next.picked !== p.hold!.picked) setHolding((h) => (h ? { ...h, picked: next.picked } : h));
    if (next.grabbed && !p.hold!.grabbed) setDragging(true);
    p.hold = next;
    setX(next.knob);
  };
  const endPress = (e: PointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    clearTimeout(p.timer);
    clearTimeout(p.dwell);
    setDragging(false);
    if (!p.held) {
      if (!p.gone && !cancelled) tapPill(p.kind);
      return;
    }
    const h = p.hold!;
    setHolding(null);
    if (!cancelled && holdCommits(h, max)) {
      setX(h.kind === "deny" ? 0 : max);
      decide(h.kind, h.picked);
    } else setX(0);
  };
  // Keyboard presses arrive as clicks with no pointer behind them.
  const onPillClick = (kind: Hold["kind"]) => (e: MouseEvent<HTMLButtonElement>) => {
    if (e.detail === 0) tapPill(kind);
  };

  // ---------- a single row's Not now: hold to slide, or tap to arm ----------
  const aside = useRef<{ id: number; x0: number; timer: number; held: boolean; gone: boolean } | null>(null);
  const onAsideDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (!canBack || e.button !== 0 || max <= 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const a = { id: e.pointerId, x0: e.clientX, timer: 0, held: false, gone: false };
    a.timer = window.setTimeout(() => {
      if (aside.current !== a || a.gone) return;
      a.held = true;
      navigator.vibrate?.(8);
      setAsideHeld(true);
      setX(max);
    }, HOLD_MS);
    aside.current = a;
  };
  const onAsideMove = (e: PointerEvent<HTMLButtonElement>) => {
    const a = aside.current;
    if (!a || a.id !== e.pointerId) return;
    if (!a.held) {
      if (Math.abs(e.clientX - a.x0) > 10) a.gone = true;
      return;
    }
    setDragging(true);
    setX(slide(max, e.clientX - a.x0, max));
  };
  const endAside = (e: PointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const a = aside.current;
    if (!a || a.id !== e.pointerId) return;
    aside.current = null;
    clearTimeout(a.timer);
    setDragging(false);
    if (!a.held) {
      if (!a.gone && !cancelled) arm(tapBack(now.current.armed));
      return;
    }
    setAsideHeld(false);
    const r = letGo(x, max, max, true);
    if (!cancelled && r.done) {
      setX(0);
      decide("deny", -1);
    } else setX(0);
  };

  // ---------- what it says ----------
  const pickedSpan = holding?.kind === "always" ? spans[holding.picked] : armed === "always" ? spans[span] : undefined;
  const says = mode === "always" ? (pickedSpan ? (pickedSpan.says ?? `Always · ${pickedSpan.words}`) : "Pause on a choice") : title;
  const blockSpan = holding?.kind === "deny" ? blocks[holding.picked] : undefined;
  const backSays = back ? (blockSpan?.says ?? back.swipe ?? `Swipe ${/^not\b/i.test(back.word) ? "for" : "to"} ${back.word.toLowerCase()}`) : "";
  const progress = max ? x / max : 0;
  const ease = dragging ? "" : "motion-safe:transition-[transform,opacity,right,left,background-color] motion-safe:duration-300 motion-safe:ease-[cubic-bezier(.2,.8,.2,1)]";
  const backTone = single ? (light ? "bg-white/16 text-white" : "bg-muted text-foreground") : "bg-deny text-white";
  const mainTone = light ? "bg-white/16 text-white" : "bg-foreground text-background";
  const inset = single && !wide && mode !== "deny" ? asideW + GAP : 0;

  return (
    <div ref={root} className={cn("relative flex select-none flex-col", className)} style={{ gap: GAP }}>
      <div
        ref={trackEl}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={fromEnd ? backSays : mode === "allow" ? (label ?? title) : says}
        aria-disabled={!canRight || undefined}
        aria-describedby={undefined}
        onPointerDown={onTrackDown}
        onPointerMove={onTrackMove}
        onPointerUp={onTrackUp}
        onPointerCancel={onTrackCancel}
        onKeyDown={onTrackKey}
        className={cn("relative touch-pan-y rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", disabled && "opacity-45", canRight && "cursor-grab active:cursor-grabbing")}
        style={{ height: TRACK_H }}
      >
        {back && (
          <div
            className={cn("absolute inset-y-0 right-0 flex items-center overflow-hidden rounded-full", backTone, ease)}
            style={single ? { left: mode === "deny" ? 0 : Math.max(0, w - asideW), opacity: mode === "deny" ? 1 : 0 } : { left: 0, opacity: mode === "deny" ? 1 : 0 }}
          >
            <span className="w-full truncate pr-14 pl-5 text-center font-semibold text-[15px]" style={{ opacity: mode === "deny" ? 1 - (max ? (max - x) / max : 0) * 0.9 : 0 }}>
              {backSays}
            </span>
          </div>
        )}
        <div
          className={cn("absolute inset-y-0 left-0 flex items-center overflow-hidden rounded-full", mainTone, ease)}
          style={{ right: inset, opacity: mode === "deny" ? 0 : 1 }}
        >
          <span className={cn("w-full truncate text-center font-semibold text-[15px]", busy ? "pr-14 pl-5" : "pr-5 pl-14")} style={{ opacity: busy ? 1 : (canRight ? 1 : 0.6) * (1 - progress) }}>
            {says}
          </span>
        </div>
        <span
          aria-hidden="true"
          className={cn(
            "absolute grid place-items-center rounded-full shadow-sm [&_svg]:size-5",
            light ? "bg-white text-[#21452F]" : fromEnd && single ? "bg-foreground text-background" : "bg-background text-foreground",
            fromEnd && !single && "text-deny",
            ease,
          )}
          style={{ left: PAD, top: PAD, width: KNOB, height: KNOB, transform: `translateX(${nudge && !fromEnd ? 26 : x}px)` }}
        >
          {busy ? <Spinner /> : fromEnd ? <ChevronLeftIcon strokeWidth={2.4} /> : (glyph ?? <ChevronRightIcon strokeWidth={2.4} />)}
        </span>
        {single && back && (
          <button
            ref={asideEl}
            type="button"
            disabled={!canBack}
            onPointerDown={onAsideDown}
            onPointerMove={onAsideMove}
            onPointerUp={(e) => endAside(e, false)}
            onPointerCancel={(e) => endAside(e, true)}
            onClick={(e) => e.detail === 0 && arm(tapBack(now.current.armed))}
            aria-label={back.word}
            className={cn(
              "absolute inset-y-0 right-0 inline-flex touch-none items-center gap-1 rounded-full px-4 font-semibold text-[15px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              light ? "bg-white/16 text-white" : "bg-muted text-foreground",
              (wide || mode === "deny") && "pointer-events-none opacity-0",
              ease,
            )}
          >
            <ChevronLeftIcon className="size-4 opacity-70" />
            {back.word}
          </button>
        )}
      </div>

      {always && back && (armed === "always" && !holding ? (
        // Always tapped: its spans in the pills' place, to pick; × goes back.
        <div className="flex gap-2" role="radiogroup" aria-label="Always, for how long">
          {spans.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={i === span}
              onClick={() => setSpan(i)}
              className={cn("h-11 flex-1 truncate rounded-full px-2 font-semibold text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", i === span ? "bg-foreground text-background" : "bg-muted text-foreground")}
            >
              {s.words}
            </button>
          ))}
          <button type="button" aria-label="Not always" onClick={() => arm("allow")} className="grid size-11 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <XIcon className="size-4" />
          </button>
        </div>
      ) : (
        <div ref={pillsEl} className="flex" style={{ gap: GAP }}>
          {(["always", "deny"] as const).map((kind) => {
            const on = mode === kind;
            const enabled = kind === "always" ? canAlways : canBack;
            const word = kind === "always" ? (always.word ?? "Always") : armed === "deny" && !holding ? "Cancel" : back.word;
            return (
              <button
                key={kind}
                type="button"
                disabled={!enabled}
                aria-pressed={on}
                aria-label={word}
                title={kind === "always" ? "Hold, rest on how long, then slide up and swipe. Or tap to choose." : "Hold, slide up and swipe left. Or tap, then swipe left."}
                onPointerDown={onPillDown(kind)}
                onPointerMove={onPillMove}
                onPointerUp={(e) => endPress(e, false)}
                onPointerCancel={(e) => endPress(e, true)}
                onClick={onPillClick(kind)}
                className={cn(
                  "inline-flex h-11 flex-1 touch-none items-center justify-center gap-2 rounded-full font-semibold text-[15px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-45",
                  on ? (kind === "deny" ? "bg-deny text-white" : "bg-foreground text-background") : "bg-muted text-foreground",
                  "motion-safe:transition-colors",
                )}
              >
                {kind === "always" ? <RepeatIcon className="size-4" /> : <XIcon className={cn("size-4", !on && "text-deny")} />}
                {word}
              </button>
            );
          })}
        </div>
      ))}

      {/* A hold under way: its spans as chips between the pills and the track, where the model hit-tests them. */}
      {holding && holding.chips.length > 0 && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10">
          {spansOf(holding.kind).map((s, i) => {
            const r = holding.chips[i]!;
            const on = holding.picked === i;
            return (
              <span
                key={s.id}
                data-chip={s.id}
                className={cn(
                  "absolute grid place-items-center rounded-full font-semibold text-[15px] shadow-lg shadow-black/20 motion-safe:transition-transform motion-safe:duration-150 motion-safe:animate-in motion-safe:zoom-in-75",
                  on ? (holding.kind === "deny" ? "scale-110 bg-deny text-white" : "scale-110 bg-foreground text-background") : "bg-card text-foreground",
                )}
                style={{ left: r.x, top: r.y, width: r.w, height: CHIP_H }}
              >
                {s.icon ?? s.short ?? s.words}
              </span>
            );
          })}
        </div>
      )}
      <span className="sr-only" aria-live="polite">{holding ? (holding.kind === "always" ? says : backSays) : ""}</span>
    </div>
  );
}
