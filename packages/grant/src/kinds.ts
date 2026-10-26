/** Placeholder kinds; not registered with the NIPs repository. */
export const KIND = {
  request: 4840,
  grant: 4841,
  revoke: 4842,
  receipt: 4843,
  stop: 4844,
  approval: 4845,
  policy: 34840,
} as const;

export type Kind = (typeof KIND)[keyof typeof KIND];
