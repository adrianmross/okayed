import { describe, expect, it } from "vitest";
import {
  ARMED_MS, CHIP_GAP, CHIP_H, CHIP_W, COMMIT_AT, DWELL_MS, KNOB, PAD, chipAt, chipsOf, grabs, holdCommits, holdDwell, holdHome, holdMove, holdStart,
  knobAt, knobMax, letGo, slide, tapBack, type Hold, type Rect,
} from "../src/okayed/swipe-model.ts";

// A 360-wide track at the top; the pills 60 below it, Always on the left half and Deny on the right.
const TRACK: Rect = { x: 0, y: 0, w: 360, h: KNOB + PAD * 2 };
const MAX = knobMax(TRACK.w);
const chipY = 60 / 2 + TRACK.h / 2;
const ALWAYS_CHIPS = chipsOf(TRACK, 3, 90, chipY);
const DENY_CHIPS = chipsOf(TRACK, 3, 270, chipY);
const mid = (r: Rect) => [r.x + r.w / 2, r.y + r.h / 2] as const;

describe("the knob", () => {
  it("travels the track less itself, and follows the finger inside it", () => {
    expect(MAX).toBe(360 - KNOB - 2 * PAD);
    expect(slide(0, 500, MAX)).toBe(MAX);
    expect(slide(MAX, -500, MAX)).toBe(0);
    expect(knobAt(TRACK, 0)).toBe(0);
    expect(knobAt(TRACK, 200)).toBe(200 - PAD - KNOB / 2);
  });

  it("decides a right swipe past 85% on a card with Always, and goes home short of it", () => {
    expect(letGo(MAX * COMMIT_AT + 1, MAX, 0, false)).toEqual({ done: true, to: MAX });
    expect(letGo(MAX * COMMIT_AT - 1, MAX, 0, false)).toEqual({ done: false, to: 0 });
  });

  it("decides the other swipes only at the far end", () => {
    expect(letGo(MAX - 10, MAX, 0, true).done).toBe(false);
    expect(letGo(MAX - 2, MAX, 0, true).done).toBe(true);
    expect(letGo(20, MAX, MAX, true)).toEqual({ done: false, to: MAX });
    expect(letGo(2, MAX, MAX, true)).toEqual({ done: true, to: 0 });
    // A left swipe never decides by percentage.
    expect(letGo(MAX * 0.1, MAX, MAX, false).done).toBe(false);
  });

  it("never decides in a track too small to swipe", () => {
    expect(letGo(0, 0, 0, false).done).toBe(false);
  });
});

describe("a tap", () => {
  it("only ever arms or disarms Deny, and arming lasts a few seconds", () => {
    expect(tapBack("allow")).toBe("deny");
    expect(tapBack("deny")).toBe("allow");
    expect(tapBack("always")).toBe("deny");
    expect(ARMED_MS).toBeGreaterThanOrEqual(3000);
  });
});

describe("chips", () => {
  it("sit in one row over the pill that was held, inside the track", () => {
    expect(ALWAYS_CHIPS.map((c) => c.x)).toEqual([0, CHIP_W + CHIP_GAP, 2 * (CHIP_W + CHIP_GAP)].map((x) => x + 90 - (3 * CHIP_W + 2 * CHIP_GAP) / 2));
    const edge = chipsOf(TRACK, 3, 5, chipY);
    expect(edge[0]!.x).toBe(0);
    const far = chipsOf(TRACK, 3, 355, chipY);
    expect(far[2]!.x + CHIP_W).toBe(360);
    expect(ALWAYS_CHIPS[0]!.h).toBe(CHIP_H);
  });

  it("are found under the finger, across the gaps but not above or below", () => {
    const [x, y] = mid(ALWAYS_CHIPS[1]!);
    expect(chipAt(ALWAYS_CHIPS, x, y)).toBe(1);
    expect(chipAt(ALWAYS_CHIPS, ALWAYS_CHIPS[1]!.x - CHIP_GAP / 2 + 1, y)).toBe(1);
    expect(chipAt(ALWAYS_CHIPS, x, ALWAYS_CHIPS[1]!.y + CHIP_H + 4)).toBe(-1);
  });
});

describe("the track takes the knob", () => {
  it("near its start for Always, near its end for Deny", () => {
    expect(grabs(TRACK, 30, 20)).toBe(true);
    expect(grabs(TRACK, 200, 20)).toBe(false);
    expect(grabs(TRACK, 340, 20, true)).toBe(true);
    expect(grabs(TRACK, 30, 20, true)).toBe(false);
    expect(grabs(TRACK, 30, 200)).toBe(false);
  });
});

/** A hold, moved through `path` with a finger that pauses `ms` at each point. */
function hold(kind: Hold["kind"], path: [number, number, number][], chips: Rect[]): Hold {
  let h = holdStart(kind, chips.length);
  let t = 0;
  for (const [x, y, ms] of path) {
    h = holdMove(h, x, y, TRACK, chips, t);
    t += ms;
    h = holdDwell(h, t);
  }
  return h;
}

describe("holding Always", () => {
  const [cx, cy] = mid(ALWAYS_CHIPS[2]!);
  const [px, py] = mid(ALWAYS_CHIPS[0]!);

  it("picks a span only by resting on it, then swipes it right", () => {
    const h = hold("always", [[90, 60, 0], [cx, cy, DWELL_MS + 10], [20, 20, 0], [340, 20, 0]], ALWAYS_CHIPS);
    expect(h).toMatchObject({ picked: 2, grabbed: true });
    expect(holdCommits(h, MAX)).toBe(true);
  });

  it("passing over a chip picks nothing, and without a span the knob can't be taken", () => {
    const h = hold("always", [[90, 60, 0], [px, py, 50], [20, 20, 0], [340, 20, 0]], ALWAYS_CHIPS);
    expect(h).toMatchObject({ picked: -1, grabbed: false, knob: holdHome("always", MAX) });
    expect(holdCommits(h, MAX)).toBe(false);
  });

  it("keeps the last span rested on, and lifting short of the end does nothing", () => {
    const h = hold("always", [[px, py, DWELL_MS + 1], [cx, cy, DWELL_MS + 1], [20, 20, 0], [200, 20, 0]], ALWAYS_CHIPS);
    expect(h.picked).toBe(2);
    expect(holdCommits(h, MAX)).toBe(false);
  });

  it("with one span, it's picked from the start", () => {
    expect(holdStart("always", 1).picked).toBe(0);
  });
});

describe("holding Deny", () => {
  it("swipes left from the end to deny once, with no span needed", () => {
    const h = hold("deny", [[270, 60, 0], [340, 20, 0], [0, 20, 0]], DENY_CHIPS);
    expect(h).toMatchObject({ picked: -1, grabbed: true });
    expect(holdCommits(h, MAX)).toBe(true);
  });

  it("or rests on a span first, to block requests like this for that long", () => {
    const [x, y] = mid(DENY_CHIPS[0]!);
    const h = hold("deny", [[270, 60, 0], [x, y, DWELL_MS + 5], [340, 20, 0], [0, 20, 0]], DENY_CHIPS);
    expect(h).toMatchObject({ picked: 0, grabbed: true });
    expect(holdCommits(h, MAX)).toBe(true);
  });

  it("waits at the end, and only a long left swipe decides", () => {
    expect(holdHome("deny", MAX)).toBe(MAX);
    const h = hold("deny", [[270, 60, 0], [340, 20, 0], [200, 20, 0]], DENY_CHIPS);
    expect(holdCommits(h, MAX)).toBe(false);
  });
});
