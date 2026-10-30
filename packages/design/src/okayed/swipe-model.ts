/**
 * The rules of swipe to decide (`swipe-decide.tsx`), pure so they can be tested and reused by any renderer. All
 * coordinates are the control's own: its top left is 0, 0.
 *
 * - The knob is dragged from its home: the track's start, or its end for a left swipe. Let go: a right swipe on a
 *   card with Always decides past `COMMIT_AT` of the travel; every other swipe is full length, the knob within
 *   `END_SLOP` of the far end. Short of it, the knob goes home and nothing is done.
 * - A tap is never an answer. A tap on Deny arms the left swipe; another tap, or `ARMED_MS` with nothing done, goes
 *   back to Allow.
 * - A hold (Always or Deny, held `HOLD_MS`) is one motion. Its spans pop up as chips between the pills and the track;
 *   a chip is picked only once the finger rests on it `DWELL_MS`, never by passing over it, and the pick stays until
 *   another is rested on. Then the finger goes on into the track by the knob, takes it, and swipes: right for Always
 *   (which needs a span), left from the end for Deny (where a span is optional: none denies once, one blocks requests
 *   like this for that long). Lifted anywhere short of that: nothing is done.
 */

export type Rect = { x: number; y: number; w: number; h: number };
/** What the track answers: Allow, Always for a span, or the other answer (Deny, Not now). */
export type Mode = "allow" | "always" | "deny";

export const KNOB = 44;
export const PAD = 4;
/** How long Always or Deny is held before its chips show and the finger may slide. */
export const HOLD_MS = 250;
/** Past this share of the knob's travel, a right swipe on a card with Always decides (and a held Deny's left one). */
export const COMMIT_AT = 0.85;
/** How near the far end the knob must come for a full-length swipe. */
export const END_SLOP = 4;
/** How long a tapped Deny stays armed with nothing done. */
export const ARMED_MS = 6000;
/** How long the finger rests on a chip before it is picked. */
export const DWELL_MS = 180;
/** How far past the knob a sliding finger may come into the track and still take it. */
export const GRAB_SLACK = 28;
/** A span's chip, and the gap between two. */
export const CHIP_W = 48;
export const CHIP_H = 34;
export const CHIP_GAP = 6;
/** How far outside the track a finger still counts as on it. */
const SLOP = 8;

export function inside(r: Rect, x: number, y: number, slop = 0): boolean {
  return x >= r.x - slop && x <= r.x + r.w + slop && y >= r.y - slop && y <= r.y + r.h + slop;
}

/** How far the knob can travel in a track `w` wide. */
export function knobMax(w: number): number {
  return Math.max(0, w - KNOB - PAD * 2);
}

/** Where the knob sits with the finger at `x`: centred under it, inside the track. */
export function knobAt(track: Rect, x: number): number {
  return Math.max(0, Math.min(knobMax(track.w), x - track.x - PAD - KNOB / 2));
}

export function commits(knob: number, max: number): boolean {
  return max > 0 && knob >= max * COMMIT_AT;
}

/** The knob dragged `dx` from `home` (0, or `max` for a left swipe): it follows the finger, inside its travel. */
export function slide(home: number, dx: number, max: number): number {
  return Math.max(0, Math.min(max, home + dx));
}

/**
 * The knob, dragged from `home`, let go at `knob`: whether that decides, and where the knob goes. `full`: only the far
 * end decides; otherwise past `COMMIT_AT` (right swipes only). Short of it: home, nothing done.
 */
export function letGo(knob: number, max: number, home: number, full: boolean): { done: boolean; to: number } {
  const left = home > 0;
  const done = max > 0 && (full ? (left ? knob <= END_SLOP : knob >= max - END_SLOP) : !left && commits(knob, max));
  return { done, to: done ? (left ? 0 : max) : home };
}

/** A tap on Deny: arms the left swipe or, armed, goes back to Allow. Never an answer. */
export function tapBack(mode: Mode): Mode {
  return mode === "deny" ? "allow" : "deny";
}

/** A row of `n` chips centred on `cx`, `cy` (over the pill that was held), kept inside the track's width. */
export function chipsOf(track: Rect, n: number, cx: number, cy: number): Rect[] {
  const w = n * CHIP_W + Math.max(0, n - 1) * CHIP_GAP;
  const x0 = Math.max(track.x, Math.min(track.x + track.w - w, cx - w / 2));
  return Array.from({ length: n }, (_, i) => ({ x: x0 + i * (CHIP_W + CHIP_GAP), y: cy - CHIP_H / 2, w: CHIP_W, h: CHIP_H }));
}

/** Which chip is under the finger, or -1. */
export function chipAt(chips: Rect[], x: number, y: number): number {
  // Sideways slop of half the gap, so a finger crossing between two never drops off; none up or down, so a finger
  // resting on the pill under them is on none.
  const s = CHIP_GAP / 2;
  return chips.findIndex((b) => x >= b.x - s && x <= b.x + b.w + s && y >= b.y && y <= b.y + b.h);
}

/** The finger near the track's start (Always), or its end (Deny), where it takes the knob. */
export function grabs(track: Rect, x: number, y: number, end = false): boolean {
  if (!inside(track, x, y, SLOP)) return false;
  return end ? track.x + track.w - x <= PAD + KNOB + GRAB_SLACK : x - track.x <= PAD + KNOB + GRAB_SLACK;
}

/**
 * A hold under way: which, the span picked (-1: none yet), the chip under the finger and since when (ms), whether the
 * finger has the knob, and where the knob is.
 */
export type Hold = { kind: "always" | "deny"; picked: number; over: number; since: number; grabbed: boolean; knob: number };

export function holdStart(kind: Hold["kind"], spans: number): Hold {
  // Always with one span has nothing to choose: it's picked. Deny needs no span at all.
  return { kind, picked: kind === "always" && spans === 1 ? 0 : -1, over: -1, since: 0, grabbed: false, knob: 0 };
}

/** Where the knob waits as a hold starts: home for Always, the track's end for Deny. */
export function holdHome(kind: Hold["kind"], max: number): number {
  return kind === "deny" ? max : 0;
}

/** Time `t` (ms) passing with the finger where it was: the chip under it is picked once it has rested there. */
export function holdDwell(h: Hold, t: number): Hold {
  if (h.grabbed || h.over < 0 || h.over === h.picked || t - h.since < DWELL_MS) return h;
  return { ...h, picked: h.over };
}

/** The finger moved to `x`, `y` at time `t` (ms) during a hold. */
export function holdMove(h: Hold, x: number, y: number, track: Rect, chips: Rect[], t: number): Hold {
  if (h.grabbed) return { ...h, knob: knobAt(track, x) };
  const deny = h.kind === "deny";
  const over = chipAt(chips, x, y);
  const next = holdDwell({ ...h, over, since: over === h.over ? h.since : t }, t);
  // Off the chips and into the track by the knob (with a span picked, for Always): the finger takes it.
  if (over < 0 && (deny || next.picked >= 0) && grabs(track, x, y, deny)) return { ...next, grabbed: true, knob: knobAt(track, x) };
  return { ...next, knob: holdHome(h.kind, knobMax(track.w)) };
}

/** The finger lifted: whether the hold decides. Anything short of a swipe with the knob is a change of mind. */
export function holdCommits(h: Hold, max: number): boolean {
  if (!h.grabbed || max <= 0) return false;
  if (h.kind === "deny") return h.knob <= max * (1 - COMMIT_AT);
  return h.picked >= 0 && commits(h.knob, max);
}
