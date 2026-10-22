import type { EventTemplate, NostrEvent } from "@okayed/grant";
import type { Condition, Effect, Targets } from "@okayed/engine";

/**
 * The only things okayed needs from a platform. Cloudflare implements them with Durable Objects, Workers AI
 * and Workflows (apps/worker); `memory.ts` implements them in-process.
 */

/** Per-user storage. `transaction` must be serializable with respect to every other call on the same user. */
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(prefix: string): Promise<Map<string, T>>;
  transaction<R>(fn: (tx: Omit<Store, "transaction">) => Promise<R>): Promise<R>;
}

export interface Clock {
  /** Unix seconds. */
  now(): number;
}

/** Signs Nostr event templates with this user's issuer key. A KMS or hardware key fits here. */
export interface Signer {
  pubkey: string;
  sign(template: EventTemplate): Promise<NostrEvent>;
}

export interface Randomness {
  /** Hex string of `bytes` random bytes. */
  hex(bytes: number): string;
}

/** What the model may see about the person's world when drafting. */
export interface DraftContext {
  now: number;
  targets: Targets;
  pending: { id: string; sentence: string; act: string; res: string[] }[];
  actions: string[];
}

export interface GrantProposalJSON {
  request?: string;
  act?: string;
  res?: string[];
  ttl?: number;
  uses?: number;
  when?: Condition[];
  aud?: string;
}

export interface PolicyProposalJSON {
  rules: { effect: Effect; act: string; res?: string; ttl?: number; maxTtl?: number; maxUses?: number }[];
}

export type Draft =
  | { intent: "grant"; grant: GrantProposalJSON; reply?: string }
  | { intent: "policy"; policy: PolicyProposalJSON; reply?: string }
  | { intent: "other"; reply: string };

/** The language model. It drafts and explains; it never decides. */
export interface Drafter {
  readonly name: string;
  draft(utterance: string, context: DraftContext): Promise<Draft>;
  /** One or two plain sentences about `facts`, or null to use the deterministic wording. */
  explain(facts: string): Promise<string | null>;
}

export type FlowEvent =
  | { type: "decision"; decision: "confirm"; assurance: { method: "web-click" | "webauthn" | "approver"; at: number; proof?: unknown } }
  | { type: "decision"; decision: "deny" }
  | { type: "revoke"; reason: string };

/** Durable orchestration of a grant's lifecycle: start a flow per proposal, deliver events to it. */
export interface Lifecycle {
  start(proposalId: string, params: FlowParams): Promise<void>;
  send(proposalId: string, event: FlowEvent): Promise<void>;
}

export interface FlowParams {
  userId: string;
  proposalId: string;
  /** Seconds to wait for the person before the proposal lapses. */
  waitSeconds: number;
  /** Set when policy auto-approved: issue without waiting. */
  auto: boolean;
}

/** Swaps a live grant for the real credential at the moment of use. The agent never sees it. */
export interface Vault {
  github(): Promise<string | null>;
}
