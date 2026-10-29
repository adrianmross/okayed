import type { Grant } from "@okayed/grant";

/**
 * UCAN 1.0 (ucan.xyz): capability tokens that delegate a command on a subject, bounded by a policy over the
 * invocation's arguments. A UCAN is the closest thing in the wild to an okayed grant, so each maps onto the other:
 * the person's issuer key is a secp256k1 `did:key`, an action is a command (`github.pr.merge` ↔ `/github/pr/merge`),
 * and the exact resources are a policy on the invocation's `res` argument.
 *
 * What doesn't map: a use count (UCANs are stateless; "once" needs the issuer to see each use) and okayed's
 * conditions, which ride in `meta`. These are payloads only: signing a UCAN envelope (DAG-CBOR with a varsig) is a
 * UCAN library's job.
 */

/** A UCAN policy statement: `["==", ".res", "github:o/r"]`, `["or", [...]]`, and the rest of UCAN's language. */
export type Statement = [string, ...unknown[]];

export interface UcanDelegation {
  iss: string;
  aud: string;
  /** Whose resources: the person, as the subject. `null` (a "powerline") delegates whatever the issuer holds. */
  sub: string | null;
  cmd: string;
  pol: Statement[];
  nonce: Uint8Array;
  meta?: Record<string, unknown>;
  nbf?: number;
  exp: number | null;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

function unbase58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

/** multicodec `secp256k1-pub` (0xe7) as a varint. */
const SECP256K1 = [0xe7, 0x01];

/**
 * A secp256k1 public key as a `did:key`: okayed's issuer key (32-byte x-only, as BIP-340 uses it, so its point has
 * an even y) or a 33-byte compressed key.
 */
export function didKey(pubkey: string): string {
  const key = pubkey.length === 64 ? `02${pubkey}` : pubkey;
  if (!/^0[23][0-9a-f]{64}$/i.test(key)) throw new Error("a secp256k1 key is 32 bytes x-only or 33 bytes compressed, in hex");
  return `did:key:z${base58(Uint8Array.from([...SECP256K1, ...unhex(key.toLowerCase())]))}`;
}

/** The x-only key of a secp256k1 `did:key` with an even point, as okayed's issuer keys are; null otherwise. */
export function pubkeyOfDid(did: string): string | null {
  const m = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)$/.exec(did);
  if (!m) return null;
  const b = unbase58(m[1]!);
  if (b.length !== 35 || b[0] !== SECP256K1[0] || b[1] !== SECP256K1[1] || b[2] !== 0x02) return null;
  return hex(b.slice(3));
}

/** `github.pr.merge` → `/github/pr/merge`. */
export const commandFor = (act: string) => `/${act.split(".").join("/")}`;
/** `/github/pr/merge` → `github.pr.merge`. */
export const actionFor = (cmd: string) => cmd.replace(/^\//, "").split("/").join(".");

/** A grant as a UCAN delegation from the person to an agent's DID, for systems that take UCANs. */
export function ucanForGrant(g: Pick<Grant, "id" | "iss" | "act" | "res" | "nbf" | "exp" | "uses" | "when" | "nonce" | "risk">, o: { audience: string }): UcanDelegation {
  const me = didKey(g.iss);
  const one = (r: string): Statement => ["==", ".res", r];
  return {
    iss: me,
    aud: o.audience,
    sub: me,
    cmd: commandFor(g.act),
    pol: g.res.length === 1 ? [one(g.res[0]!)] : [["or", g.res.map(one)]],
    nonce: unhex(g.nonce),
    nbf: g.nbf,
    exp: g.exp,
    meta: { okayed: { grant: g.id, uses: g.uses, risk: g.risk, ...(g.when.length ? { when: g.when } : {}) } },
  };
}

/**
 * What a UCAN delegation asks okayed for: an action on exact resources, in the window it gives. Only exact policies
 * are read (`==` on `.res`, or an `or` of them): a glob or a powerline is refused, never approximated.
 */
export function requestFromUcan(d: Pick<UcanDelegation, "cmd" | "pol" | "sub" | "exp" | "nbf">): { act: string; res: string[]; nbf?: number; exp?: number } {
  if (d.sub === null) throw new Error("a powerline (sub: null) names no subject to ask about");
  if (!/^\/[a-z0-9-]+(\/[a-z0-9-]+)+$/.test(d.cmd)) throw new Error(`command ${d.cmd} isn't an okayed action`);
  const exact = (s: unknown): string | null => (Array.isArray(s) && s.length === 3 && s[0] === "==" && s[1] === ".res" && typeof s[2] === "string" ? s[2] : null);
  let res: (string | null)[] = [];
  if (d.pol.length === 1 && d.pol[0]![0] === "or" && Array.isArray(d.pol[0]![1])) res = (d.pol[0]![1] as unknown[]).map(exact);
  else if (d.pol.length === 1) res = [exact(d.pol[0])];
  if (!res.length || res.some((r) => r === null)) throw new Error("only exact policies on .res can be okayed");
  return { act: actionFor(d.cmd), res: res as string[], ...(d.nbf !== undefined ? { nbf: d.nbf } : {}), ...(d.exp !== null ? { exp: d.exp } : {}) };
}
