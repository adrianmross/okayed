import type { Beyond, Facts, GrantDraft, Layer, Proposal, Request, Risk, Rule, SharedBudget, Targets, Usage, UseCode } from "@okayed/engine";
import type { Grant, NostrEvent } from "@okayed/grant";

/** Everything okayed stores for one person, and the snapshot their browser sees. */

export class OkayedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Meta {
  userId: string;
  createdAt: number;
  ownerTokenHash: string;
  /** Latest emergency stop. Grants issued at or before it are dead. */
  stoppedAt?: number;
  /** Auto-approval is off after a stop until the person resumes. */
  paused: boolean;
}

export interface AgentRecord {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
}

export type RequestStatus = "pending" | "granted" | "denied" | "expired";

export interface RequestRecord {
  request: Request;
  status: RequestStatus;
  cardId?: string;
  grantId?: string;
  reason?: string;
}

export type CardStatus = "open" | "confirming" | "confirmed" | "denied" | "lapsed" | "closed";

/** Something shown to the person: a proposed grant, a proposed policy change, a question, or a refusal. */
export interface Card {
  id: string;
  kind: "grant" | "policy" | "question" | "refuse" | "reply";
  source: "chat" | "request";
  status: CardStatus;
  createdAt: number;
  utterance?: string;
  requestId?: string | null;
  /** The deterministic sentence the person confirms. */
  sentence: string;
  allows: string[];
  doesNot: string[];
  risk?: Risk;
  beyond: Beyond[];
  notes: string[];
  summary?: string;
  decision?: { verdict: string; reason: string; layers: { layer: string; verdict: string; why: string }[] };
  /** The model's plain-words explanation, if any. Never what is confirmed. */
  explanation?: string | null;
  draft?: GrantDraft;
  ttl?: number;
  asked?: Proposal;
  rules?: Rule[];
  ruleTexts?: string[];
  warnings?: string[];
  question?: string;
  options?: string[];
  grantId?: string;
  closedReason?: string;
  /** Set when a standing policy's spent budget is why this asks: the rule to top up. */
  topUp?: string;
  drafter?: string;
}

export type GrantStatus = "active" | "expired" | "revoked" | "used";

export interface GrantRecord {
  grant: Grant;
  event: NostrEvent;
  cardId: string;
  used: number;
  status: GrantStatus;
  revokedAt?: number;
  /** The budgets this grant drew on when it was issued (rule ids and `budget:<id>`). */
  drew?: string[];
  revokeReason?: string;
}

export interface AuditEntry {
  at: number;
  type: string;
  text: string;
  ref?: string;
  event?: NostrEvent;
}

export interface ChatMessage {
  at: number;
  role: "person" | "okayed";
  text: string;
  cardId?: string;
}

export interface VerifyInput {
  event?: unknown;
  grantId?: string;
  aud: string;
  act: string;
  res: string;
  consume: boolean;
  facts?: Facts;
}

export type VerifyResult =
  | { ok: true; grant: string; left: number; receipt?: NostrEvent }
  | { ok: false; code: UseCode | "unknown_grant" | "bad_event"; reason: string };

export interface Snapshot {
  userId: string;
  issuer: string;
  drafter: string;
  now: number;
  paused: boolean;
  stoppedAt?: number;
  policy: { budgets: SharedBudget[]; layers: Layer[]; described: { layer: string; rules: { id: string; text: string; effect: string; until?: number }[] }[]; warnings: string[] };
  cards: Card[];
  requests: RequestRecord[];
  grants: (GrantRecord & { sentence: string })[];
  audit: AuditEntry[];
  chat: ChatMessage[];
  agents: { id: string; name: string; createdAt: number }[];
  targets: Targets;
  /** What each standing policy has spent, by rule id. */
  usage: Usage;
}

