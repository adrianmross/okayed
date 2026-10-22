import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import type { GrantBody, GrantDraft, Request } from "@okayed/engine";
import { jcs } from "./jcs.ts";
import { KIND } from "./kinds.ts";
import { signEvent, tag, verifyEvent, type EventTemplate, type NostrEvent } from "./nostr.ts";

export type AssuranceMethod = "policy" | "web-click" | "webauthn" | "approver";

export interface Assurance {
  method: AssuranceMethod;
  at: number;
  /** A proof for methods that have one (WebAuthn assertion, an approver app's signed answer). */
  proof?: unknown;
}

export interface Grant extends GrantBody {
  iss: string;
  assurance: Assurance;
  from: { utterance: string; request: string | null };
  nonce: string;
}

export function sha256Hex(s: string): string {
  return bytesToHex(sha256(utf8ToBytes(s)));
}

/** `sha256(JCS(grant without id))`. */
export function grantId(g: Omit<Grant, "id"> | Grant): string {
  const { id: _drop, ...rest } = g as Grant;
  return sha256Hex(jcs(rest));
}

export function buildGrant(draft: GrantDraft, iss: string, assurance: Assurance, nonce: string): Grant {
  const body: Omit<Grant, "id"> = {
    v: 0,
    iss,
    aud: draft.aud,
    act: draft.act,
    res: [...draft.res],
    when: draft.when.map((c) => ({ ...c })),
    nbf: draft.nbf,
    exp: draft.exp,
    uses: draft.uses,
    risk: draft.risk,
    assurance,
    from: { ...draft.from },
    nonce,
  };
  return { ...body, id: grantId(body) } as Grant;
}

/** Event template for a grant; sign it with `signEvent` or any `Signer`. */
export function grantTemplate(g: Grant): EventTemplate {
  return {
    kind: KIND.grant,
    created_at: g.nbf,
    tags: [
      ["x", g.id],
      ["act", g.act],
      ["aud", g.aud],
      ["expiration", String(g.exp)],
    ],
    content: jcs(g),
  };
}

export function grantEvent(g: Grant, secretKey: Uint8Array, auxRand?: Uint8Array): NostrEvent {
  return signEvent(grantTemplate(g), secretKey, auxRand);
}

export type GrantCheck = { ok: true; grant: Grant } | { ok: false; reason: string };

/**
 * Offline checks 1–2 of docs/grant-format.md: signature, kind, issuer, id and expiration tag.
 * `trusted` is the set of issuer keys the verifier accepts for this user.
 */
export function openGrantEvent(e: unknown, trusted?: Iterable<string>): GrantCheck {
  if (!verifyEvent(e)) return { ok: false, reason: "bad signature or malformed event" };
  if (e.kind !== KIND.grant) return { ok: false, reason: `kind ${e.kind} is not a grant` };
  let g: Grant;
  try {
    g = JSON.parse(e.content) as Grant;
  } catch {
    return { ok: false, reason: "content is not JSON" };
  }
  if (!g || typeof g !== "object" || g.v !== 0) return { ok: false, reason: "unsupported grant version" };
  if (jcs(g) !== e.content) return { ok: false, reason: "content is not canonical JSON" };
  if (g.iss !== e.pubkey) return { ok: false, reason: "issuer does not match the signing key" };
  if (trusted && ![...trusted].includes(g.iss)) return { ok: false, reason: "issuer is not trusted" };
  if (grantId(g) !== g.id) return { ok: false, reason: "grant id does not match its content" };
  if (tag(e, "expiration") !== String(g.exp)) return { ok: false, reason: "expiration tag does not match exp" };
  if (tag(e, "x") !== g.id) return { ok: false, reason: "x tag does not match the grant id" };
  if (!Array.isArray(g.res) || g.res.length === 0 || !Number.isInteger(g.uses) || g.uses < 1) {
    return { ok: false, reason: "grant has no resources or no uses" };
  }
  return { ok: true, grant: g };
}

export interface Revoke {
  v: 0;
  grant: string;
  reason: string;
  at: number;
}

export interface UseReceipt {
  v: 0;
  grant: string;
  use: number;
  left: number;
  act: string;
  res: string;
  at: number;
}

export interface Stop {
  v: 0;
  reason: string;
  at: number;
}

export function requestTemplate(r: Request): EventTemplate {
  return {
    kind: KIND.request,
    created_at: r.at,
    tags: [["x", r.id], ["act", r.act], ["aud", r.aud], ["expiration", String(r.exp)]],
    content: jcs({ v: 0, ...r }),
  };
}

export function revokeTemplate(r: Revoke): EventTemplate {
  return { kind: KIND.revoke, created_at: r.at, tags: [["x", r.grant]], content: jcs(r) };
}

export function receiptTemplate(r: UseReceipt): EventTemplate {
  return { kind: KIND.receipt, created_at: r.at, tags: [["x", r.grant]], content: jcs(r) };
}

export function stopTemplate(s: Stop): EventTemplate {
  return { kind: KIND.stop, created_at: s.at, tags: [], content: jcs(s) };
}

export function policyTemplate(policy: object, at: number): EventTemplate {
  return { kind: KIND.policy, created_at: at, tags: [["d", "policy"]], content: jcs({ v: 0, ...policy, at }) };
}

/**
 * Per-user issuer key: HKDF-SHA256(service secret, salt "okayed/v0/issuer", info user id). Retries with a counter
 * in the vanishingly rare case the output is not a valid secp256k1 scalar.
 */
export function deriveIssuerKey(serviceSecret: Uint8Array, userId: string): Uint8Array {
  for (let i = 0; i < 16; i++) {
    const sk = hkdf(sha256, serviceSecret, utf8ToBytes("okayed/v0/issuer"), utf8ToBytes(`${userId}#${i}`), 32);
    try {
      schnorr.getPublicKey(sk);
      return sk;
    } catch {
      // try the next counter
    }
  }
  throw new Error("could not derive an issuer key");
}
