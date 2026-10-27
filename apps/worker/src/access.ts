/**
 * Cloudflare Access in front of okayed. With ACCESS_TEAM and ACCESS_AUD set, Access signs a JWT for every request
 * it lets through (the `Cf-Access-Jwt-Assertion` header, or the `CF_Authorization` cookie). A valid one stands in
 * for the owner token: the person's identity picks their okayed, so there is nothing to copy between devices.
 */

export interface AccessIdentity {
  /** Access's stable id for the person, or for a service token. */
  sub: string;
  email?: string;
  /** Set for a service token (machine-to-machine), instead of a person. */
  commonName?: string;
}

interface Jwk extends JsonWebKey {
  kid: string;
}

const keys = new Map<string, { at: number; keys: Jwk[] }>();

async function certs(team: string, f: typeof fetch): Promise<Jwk[]> {
  const cached = keys.get(team);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.keys;
  const r = await f(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`Access certs: HTTP ${r.status}`);
  const body = (await r.json()) as { keys: Jwk[] };
  keys.set(team, { at: Date.now(), keys: body.keys });
  return body.keys;
}

function b64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function tokenOf(req: Request): string | null {
  const h = req.headers.get("cf-access-jwt-assertion");
  if (h) return h;
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.get("cookie") ?? "");
  return m?.[1] ?? null;
}

/** The Access identity on this request, or null when there is none or it doesn't verify. */
export async function accessIdentity(req: Request, team: string, aud: string, now = Date.now() / 1000, f: typeof fetch = fetch): Promise<AccessIdentity | null> {
  const jwt = tokenOf(req);
  if (!jwt) return null;
  const [h, p, sig] = jwt.split(".");
  if (!h || !p || !sig) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(h))) as { alg?: string; kid?: string };
    const claims = JSON.parse(new TextDecoder().decode(b64url(p))) as { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; sub?: string; email?: string; common_name?: string };
    if (header.alg !== "RS256") return null;
    const jwk = (await certs(team, f)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(aud) || claims.iss !== `https://${team}.cloudflareaccess.com`) return null;
    if (typeof claims.exp !== "number" || claims.exp <= now || (typeof claims.nbf === "number" && claims.nbf > now + 60)) return null;
    const id: AccessIdentity = { sub: claims.sub || claims.common_name || "" };
    if (!id.sub) return null;
    if (claims.email) id.email = claims.email;
    if (claims.common_name) id.commonName = claims.common_name;
    return id;
  } catch {
    return null;
  }
}

/** The okayed user an Access identity owns: a stable 32-hex id derived from the team and the person. */
export async function userForIdentity(team: string, id: AccessIdentity): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`access:${team}:${id.sub}`));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}
