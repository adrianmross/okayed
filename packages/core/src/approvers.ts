import { hexToBytes, jcs, KIND, sha256Hex, tag, verifyEvent, type EventTemplate, type NostrEvent } from "@okayed/grant";
import type { Risk } from "@okayed/engine";

/**
 * Approvers: where the person says yes. Every approver signs the same thing, a card's binding, whose JCS hash is the
 * challenge, so a proof can only okay that exact draft.
 *
 * - Local: the device the person is looking at. Today that's a passkey (`passkeys.ts`): the browser asks for the
 *   challenge and returns a WebAuthn assertion.
 * - Pushed: an approver app the person paired on another device, such as their phone. okayed keeps the approval in
 *   that person's inbox and may wake the app (`Notifier`); the app fetches it with a signed request, shows it, and
 *   answers with an approval event (kind 4845) signed by its own key. The transport is never trusted, only that
 *   signature.
 */

/** What an approval signs: the card, a hash of its draft, and a nonce. */
export interface ApprovalBinding {
  v: 0;
  card: string;
  draft: string;
  nonce: string;
}

export function bindingFor(cardId: string, draft: unknown, nonce: string): ApprovalBinding {
  return { v: 0, card: cardId, draft: sha256Hex(jcs(draft)), nonce };
}

/** The challenge for a binding, hex: sha256 of its JCS form. WebAuthn takes the same bytes. */
export function challengeHex(b: ApprovalBinding): string {
  return sha256Hex(jcs(b));
}

export function challengeFor(b: ApprovalBinding): Uint8Array<ArrayBuffer> {
  return new Uint8Array(hexToBytes(challengeHex(b)));
}

/** An approver app paired with this person, known by its BIP-340 public key. */
export interface PairedApprover {
  pubkey: string;
  name: string;
  createdAt: number;
}

/** What a pushed approver is shown: enough to render the card, plus the binding it must sign. */
export interface PushedApproval {
  v: 0;
  card: string;
  binding: ApprovalBinding;
  sentence: string;
  act?: string;
  res?: string[];
  risk?: Risk;
  /** Unix seconds after which the answer is refused. */
  exp: number;
}

/**
 * Wakes a paired approver app when something is waiting for it. The nudge carries nothing; the app fetches its
 * inbox. A relay subscription, a push gateway or a webhook fits here.
 */
export interface Notifier {
  readonly name: string;
  notify(approver: PairedApprover): Promise<void>;
}

/** The answer an approver app signs. */
export interface ApprovalAnswer {
  v: 0;
  binding: ApprovalBinding;
  verdict: "allow" | "deny";
}

/** The approval event (kind 4845): content is the JCS answer; `x` is the challenge, `card` the card it answers. */
export function answerTemplate(a: ApprovalAnswer, at: number): EventTemplate {
  return {
    kind: KIND.approval,
    created_at: at,
    tags: [
      ["x", challengeHex(a.binding)],
      ["card", a.binding.card],
      ["verdict", a.verdict],
    ],
    content: jcs(a),
  };
}

export type AnswerCheck = { ok: true; answer: ApprovalAnswer; approver: PairedApprover } | { ok: false; reason: string };

/** Checks an approval event against the paired approvers and the binding okayed is waiting on. */
export function readAnswer(e: unknown, approvers: PairedApprover[], expected: ApprovalBinding): AnswerCheck {
  if (!verifyEvent(e) || e.kind !== KIND.approval) return { ok: false, reason: "not a signed approval event" };
  const approver = approvers.find((a) => a.pubkey === e.pubkey);
  if (!approver) return { ok: false, reason: "that approver isn't paired" };
  let answer: ApprovalAnswer;
  try {
    answer = JSON.parse(e.content) as ApprovalAnswer;
  } catch {
    return { ok: false, reason: "the approval is not JSON" };
  }
  if (answer.v !== 0 || (answer.verdict !== "allow" && answer.verdict !== "deny")) return { ok: false, reason: "unknown approval format" };
  if (jcs(answer.binding) !== jcs(expected) || tag(e, "x") !== challengeHex(expected)) return { ok: false, reason: "the approval is for something else" };
  return { ok: true, answer, approver };
}

/**
 * Signed HTTP requests from approver apps (NIP-98): a kind-27235 event naming the URL and method, signed within the
 * last minute. Returns the signer's public key, or why not.
 */
export function readHttpAuth(header: string | null, url: string, method: string, now: number): { ok: true; pubkey: string } | { ok: false; reason: string } {
  if (!header?.startsWith("Nostr ")) return { ok: false, reason: "sign the request (NIP-98)" };
  let e: unknown;
  try {
    e = JSON.parse(atob(header.slice(6).trim()));
  } catch {
    return { ok: false, reason: "the signed request is not valid" };
  }
  if (!verifyEvent(e) || e.kind !== 27235) return { ok: false, reason: "the signed request is not valid" };
  if (Math.abs(now - e.created_at) > 60) return { ok: false, reason: "the signed request is too old" };
  if (tag(e, "u") !== url || tag(e, "method")?.toUpperCase() !== method.toUpperCase()) return { ok: false, reason: "the signed request is for another URL" };
  return { ok: true, pubkey: e.pubkey };
}

export type { NostrEvent };
