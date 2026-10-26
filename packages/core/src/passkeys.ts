import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { challengeFor, type ApprovalBinding } from "./approvers.ts";

/**
 * Passkeys (WebAuthn), the local approver: Face ID, Touch ID, Windows Hello or a security key. The challenge is the
 * card's binding (`approvers.ts`), so the signed assertion stored on the grant proves the person okayed exactly that
 * draft, and anyone with the public key can check it.
 */

/** Where the person's browser is: the relying party a passkey belongs to. */
export interface RelyingParty {
  rpID: string;
  origin: string;
  rpName?: string;
}

export interface StoredPasskey {
  id: string;
  /** COSE public key, base64url. */
  publicKey: string;
  counter: number;
  transports?: string[];
  rpID: string;
  name: string;
  createdAt: number;
}

/** Stored on the grant as `assurance.proof` when the person approved with a passkey. */
export interface PasskeyProof {
  credential: string;
  publicKey: string;
  rpID: string;
  origin: string;
  binding: ApprovalBinding;
  response: { clientDataJSON: string; authenticatorData: string; signature: string };
}

export function toB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function registrationOptions(rp: RelyingParty, userId: string, existing: StoredPasskey[]) {
  return generateRegistrationOptions({
    rpName: rp.rpName ?? "okayed",
    rpID: rp.rpID,
    userName: "okayed",
    userDisplayName: "Your okayed",
    userID: new Uint8Array(new TextEncoder().encode(userId)),
    attestationType: "none",
    excludeCredentials: existing.filter((p) => p.rpID === rp.rpID).map((p) => ({ id: p.id, ...(p.transports ? { transports: p.transports } : {}) })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
}

export async function verifyRegistration(rp: RelyingParty, response: unknown, expectedChallenge: string, name: string, now: number): Promise<StoredPasskey> {
  const out = await verifyRegistrationResponse({
    response: response as never,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: true,
  });
  if (!out.verified || !out.registrationInfo) throw new Error("the passkey could not be verified");
  const c = out.registrationInfo.credential;
  return { id: c.id, publicKey: toB64url(c.publicKey), counter: c.counter, ...(c.transports ? { transports: c.transports } : {}), rpID: rp.rpID, name, createdAt: now };
}

export async function approvalOptions(rp: RelyingParty, binding: ApprovalBinding, passkeys: StoredPasskey[]) {
  return generateAuthenticationOptions({
    rpID: rp.rpID,
    challenge: challengeFor(binding),
    userVerification: "required",
    allowCredentials: passkeys.filter((p) => p.rpID === rp.rpID).map((p) => ({ id: p.id, ...(p.transports ? { transports: p.transports } : {}) })),
  });
}

/** Verifies an approval assertion against the stored passkey and the binding; returns the proof and new counter. */
export async function verifyApproval(rp: RelyingParty, response: unknown, binding: ApprovalBinding, passkeys: StoredPasskey[]): Promise<{ proof: PasskeyProof; passkey: StoredPasskey; counter: number }> {
  const r = response as { id?: string; response?: { clientDataJSON: string; authenticatorData: string; signature: string } };
  const passkey = passkeys.find((p) => p.id === r.id && p.rpID === rp.rpID);
  if (!passkey || !r.response) throw new Error("that passkey isn't registered here");
  const out = await verifyAuthenticationResponse({
    response: response as never,
    expectedChallenge: toB64url(challengeFor(binding)),
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    credential: { id: passkey.id, publicKey: fromB64url(passkey.publicKey), counter: passkey.counter, ...(passkey.transports ? { transports: passkey.transports } : {}) },
    requireUserVerification: true,
  });
  if (!out.verified) throw new Error("Face ID didn't verify");
  const proof: PasskeyProof = {
    credential: passkey.id,
    publicKey: passkey.publicKey,
    rpID: rp.rpID,
    origin: rp.origin,
    binding,
    response: { clientDataJSON: r.response.clientDataJSON, authenticatorData: r.response.authenticatorData, signature: r.response.signature },
  };
  return { proof, passkey, counter: out.authenticationInfo.newCounter };
}
