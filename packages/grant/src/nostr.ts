import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export interface UnsignedEvent {
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

export type EventTemplate = Omit<UnsignedEvent, "pubkey">;

export interface NostrEvent extends UnsignedEvent {
  id: string;
  sig: string;
}

const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;

/** NIP-01 event id: sha256 of `[0, pubkey, created_at, kind, tags, content]`. */
export function eventId(e: UnsignedEvent): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
}

export function publicKeyOf(secretKey: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(secretKey));
}

export function signEvent(e: EventTemplate, secretKey: Uint8Array, auxRand?: Uint8Array): NostrEvent {
  const unsigned: UnsignedEvent = { ...e, pubkey: publicKeyOf(secretKey) };
  const id = eventId(unsigned);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey, auxRand));
  return { ...unsigned, id, sig };
}

/** Checks shape, id and signature. Never throws. */
export function verifyEvent(e: unknown): e is NostrEvent {
  try {
    if (!e || typeof e !== "object") return false;
    const x = e as NostrEvent;
    if (!Number.isInteger(x.kind) || !Number.isInteger(x.created_at) || typeof x.content !== "string") return false;
    if (!HEX32.test(x.pubkey) || !HEX32.test(x.id) || !HEX64.test(x.sig)) return false;
    if (!Array.isArray(x.tags) || !x.tags.every((t) => Array.isArray(t) && t.every((s) => typeof s === "string"))) return false;
    if (eventId(x) !== x.id) return false;
    return schnorr.verify(hexToBytes(x.sig), hexToBytes(x.id), hexToBytes(x.pubkey));
  } catch {
    return false;
  }
}

export function tag(e: { tags: string[][] }, name: string): string | undefined {
  return e.tags.find((t) => t[0] === name)?.[1];
}
