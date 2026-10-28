/**
 * Who is calling, for any platform. okayed's own owner and agent tokens are built in; these add the ways the rest of
 * the world proves identity: a JWT from an OIDC issuer (Cloudflare Access, Auth0, Okta, Google, Clerk…) for a person,
 * and a workload identity token (GitHub Actions, Kubernetes, a cloud's metadata server…) for an agent. Nothing here is
 * tied to a runtime: it needs `fetch` and Web Crypto.
 */

export interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  [claim: string]: unknown;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

/** Web Crypto parameters, typed structurally so they work with both the DOM and the Workers type libraries. */
const ALGS: Record<string, { import: { name: string; hash?: string; namedCurve?: string }; verify: { name: string; hash?: string } }> = {
  RS256: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  ES256: { import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
};

function b64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** The claims of a JWT without checking anything: only for choosing which issuer to check it against. */
export function peekJwt(token: string): JwtClaims | null {
  try {
    const p = token.split(".")[1];
    return p ? (JSON.parse(new TextDecoder().decode(b64url(p))) as JwtClaims) : null;
  } catch {
    return null;
  }
}

const keyCache = new Map<string, { at: number; keys: Jwk[] }>();

/** An issuer's signing keys, from its JWKS URL, cached for ten minutes. */
async function keysAt(url: string, f: typeof fetch): Promise<Jwk[]> {
  const hit = keyCache.get(url);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.keys;
  const r = await f(url);
  if (!r.ok) throw new Error(`JWKS ${url}: HTTP ${r.status}`);
  const keys = ((await r.json()) as { keys: Jwk[] }).keys;
  keyCache.set(url, { at: Date.now(), keys });
  return keys;
}

const discovered = new Map<string, string>();

/** OIDC discovery: the issuer's JWKS URL, from `<issuer>/.well-known/openid-configuration`. */
export async function jwksFor(issuer: string, f: typeof fetch = fetch): Promise<string> {
  const hit = discovered.get(issuer);
  if (hit) return hit;
  const r = await f(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error(`OIDC discovery for ${issuer}: HTTP ${r.status}`);
  const uri = ((await r.json()) as { jwks_uri?: string }).jwks_uri;
  if (!uri) throw new Error(`${issuer} publishes no jwks_uri`);
  discovered.set(issuer, uri);
  return uri;
}

export interface JwtCheck {
  issuer: string;
  /** The audience this deployment expects; any one of them. */
  audience: string | string[];
  /** Where the issuer's keys are; discovered from the issuer when omitted. */
  jwks?: string;
  now?: number;
  fetch?: typeof fetch;
}

/** Verifies a JWT's signature (RS256 or ES256), issuer, audience and lifetime. Returns its claims, or null. */
export async function verifyJwt(token: string, check: JwtCheck): Promise<JwtClaims | null> {
  const f = check.fetch ?? fetch;
  const now = check.now ?? Date.now() / 1000;
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(h))) as { alg?: string; kid?: string };
    const alg = header.alg ? ALGS[header.alg] : undefined;
    if (!alg) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64url(p))) as JwtClaims;
    if (claims.iss !== check.issuer) return null;
    const want = Array.isArray(check.audience) ? check.audience : [check.audience];
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.some((a) => typeof a === "string" && want.includes(a))) return null;
    if (typeof claims.exp !== "number" || claims.exp <= now || (typeof claims.nbf === "number" && claims.nbf > now + 60)) return null;
    const keys = await keysAt(check.jwks ?? (await jwksFor(check.issuer, f)), f);
    const jwk = keys.find((k) => (header.kid ? k.kid === header.kid : true) && (alg.import.name === "ECDSA" ? k.kty === "EC" : k.kty === "RSA"));
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, alg.import, false, ["verify"]);
    const ok = await crypto.subtle.verify(alg.verify, key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
    return ok ? claims : null;
  } catch {
    return null;
  }
}

/** The bearer token on a request, if any. */
export function bearerOf(req: Request): string | null {
  const h = req.headers.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

/** A person known to an OIDC issuer: their okayed is a stable id derived from the issuer and their subject. */
export async function userForSubject(issuer: string, sub: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`oidc:${issuer}:${sub}`));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Where a person's OIDC token comes from on a request, and how to check it. */
export interface PersonIssuer {
  check: JwtCheck;
  /** The token on the request: a header, a cookie, the bearer token. */
  token(req: Request): string | null;
  /** Service tokens and other machines aren't people. */
  isPerson?(claims: JwtClaims): boolean;
}

/** Cloudflare Access as a person issuer: the `Cf-Access-Jwt-Assertion` header or the `CF_Authorization` cookie. */
export function cloudflareAccess(team: string, aud: string): PersonIssuer {
  const issuer = `https://${team}.cloudflareaccess.com`;
  return {
    check: { issuer, audience: aud, jwks: `${issuer}/cdn-cgi/access/certs` },
    token: (req) => req.headers.get("cf-access-jwt-assertion") ?? /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? null,
    isPerson: (c) => !c.common_name,
  };
}

/** Any OIDC provider, with its ID token sent as the bearer token. */
export function oidcBearer(issuer: string, audience: string): PersonIssuer {
  return { check: { issuer, audience }, token: (req) => bearerOf(req) };
}

/** The person on a request, from the first issuer whose token checks out: their stable okayed user id. */
export async function personOf(req: Request, issuers: PersonIssuer[], f?: typeof fetch): Promise<{ userId: string; claims: JwtClaims } | null> {
  for (const iss of issuers) {
    const token = iss.token(req);
    if (!token || token.split(".").length !== 3) continue;
    const claims = await verifyJwt(token, f ? { ...iss.check, fetch: f } : iss.check);
    if (!claims?.sub || (iss.isPerson && !iss.isPerson(claims))) continue;
    return { userId: await userForSubject(iss.check.issuer, claims.sub), claims };
  }
  return null;
}

/**
 * A workload the person trusts to act as one of their agents, by the identity token its platform gives it: GitHub
 * Actions (`https://token.actions.githubusercontent.com`, subject `repo:owner/name:ref:refs/heads/main`), a Kubernetes
 * service account, a cloud workload. No secret to copy into CI; the token lives minutes.
 */
export interface WorkloadTrust {
  issuer: string;
  /** The subject, exactly, or with `*` for any run of characters. */
  subject: string;
  /** The audience the workload asks its platform for; this deployment's URL is a good choice. */
  audience: string;
  /** The agent it acts as. */
  agent: string;
}

export function subjectMatches(pattern: string, sub: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(sub);
}

/** The agent a workload identity token acts as, under the person's trusts, or null. */
export async function agentForWorkload(token: string, trusts: WorkloadTrust[], f?: typeof fetch): Promise<string | null> {
  const peek = peekJwt(token);
  if (!peek?.iss || typeof peek.sub !== "string") return null;
  for (const t of trusts.filter((x) => x.issuer === peek.iss && subjectMatches(x.subject, peek.sub as string))) {
    const claims = await verifyJwt(token, { issuer: t.issuer, audience: t.audience, ...(f ? { fetch: f } : {}) });
    if (claims?.sub && subjectMatches(t.subject, claims.sub)) return t.agent;
  }
  return null;
}
