/** Short and long ways of saying a lifetime or a count, shared by narrowing and explanations. */

/** Compact, for "asked → granted" lines: "15 min", "30 d", "32 years". */
export function shortDuration(s: number): string {
  if (s >= 86400 * 365) return `${Math.round(s / (86400 * 365))} years`;
  if (s >= 86400) return `${Math.round(s / 86400)} d`;
  if (s % 3600 === 0 && s >= 3600) return `${s / 3600} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
}

/** For sentences: "15 minutes", "1 hour", "2.5 hours". */
export function longDuration(s: number): string {
  if (s < 90) return `${s} seconds`;
  if (s < 3600) return `${Math.round(s / 60)} minutes`;
  if (s < 2 * 86400) {
    const h = Math.round(s / 360) / 10;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  return `${Math.round(s / 86400)} days`;
}

/** "once", "3 times". */
export function usesLabel(n: number): string {
  return n === 1 ? "once" : `${n} times`;
}
