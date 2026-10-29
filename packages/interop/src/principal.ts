import type { JwtClaims } from "@okayed/core";

/**
 * Who someone is, in terms any permission system maps to: a stable id, the groups and roles they hold, the OAuth
 * scopes their token carries, and whether they're still active. An OIDC token, a SAML assertion, a SCIM record and a
 * Cloudflare Access identity all read into this one shape, and an organization's policy grants to it.
 */
export interface Principal {
  /** Unique across sources: `oidc:<issuer>#<sub>`, `saml:<issuer>#<nameid>`, `scim:<id>`. */
  id: string;
  /** Who vouches for it: the OIDC issuer, the SAML IdP's entity id, the directory. */
  issuer: string;
  /** Their id there: the OIDC `sub`, the SAML NameID, the SCIM `externalId`. */
  subject: string;
  name?: string;
  email?: string;
  /** Group names, lowercase. */
  groups: string[];
  /** App roles and entitlements, lowercase. */
  roles: string[];
  /** OAuth scopes their token carries. */
  scopes: string[];
  active: boolean;
}

/** Where each part of a principal is found, most likely first. A claim path may use dots: `realm_access.roles`. */
export interface ClaimNames {
  groups?: string[];
  roles?: string[];
  email?: string[];
  name?: string[];
}

/** Common OIDC claims: Okta, Microsoft Entra, Auth0 (namespaced claims: add yours), Keycloak, Google. */
export const OIDC_CLAIMS: Required<ClaimNames> = {
  groups: ["groups"],
  roles: ["roles", "realm_access.roles"],
  email: ["email", "preferred_username", "upn"],
  name: ["name"],
};

/** Common SAML attributes: Microsoft Entra and AD FS, Okta, Google, and eduPerson (by OID). */
export const SAML_ATTRIBUTES: Required<ClaimNames> = {
  groups: ["http://schemas.microsoft.com/ws/2008/06/identity/claims/groups", "http://schemas.xmlsoap.org/claims/Group", "groups", "memberOf", "urn:oid:1.3.6.1.4.1.5923.1.5.1.1"],
  roles: ["http://schemas.microsoft.com/ws/2008/06/identity/claims/role", "roles", "Role", "urn:oid:1.3.6.1.4.1.5923.1.1.1.7"],
  email: ["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", "email", "mail", "urn:oid:0.9.2342.19200300.100.1.3"],
  name: ["http://schemas.microsoft.com/identity/claims/displayname", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name", "displayName", "urn:oid:2.16.840.1.113730.3.1.241"],
};

function at(source: Record<string, unknown>, path: string): unknown {
  if (path in source) return source[path];
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), source);
}

/**
 * A group or role as policies name it: lowercase, and an LDAP distinguished name by its common name
 * (`CN=Release Managers,OU=Groups,DC=corp` → `release managers`). Objects give their `name`, `display` or `value`.
 */
export function groupName(v: unknown): string | null {
  const raw = typeof v === "string" ? v : v && typeof v === "object" ? ((v as Record<string, unknown>).name ?? (v as Record<string, unknown>).display ?? (v as Record<string, unknown>).value) : null;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const cn = /^cn=([^,]+),/i.exec(raw.trim());
  return (cn ? cn[1]! : raw).trim().toLowerCase();
}

function namesAt(source: Record<string, unknown>, paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const v = at(source, p);
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) {
      const n = groupName(x);
      if (n) out.add(n);
    }
  }
  return [...out];
}

function firstText(source: Record<string, unknown>, paths: string[]): string | undefined {
  for (const p of paths) {
    const v = at(source, p);
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === "string" && s.trim()) return s.trim();
  }
  return undefined;
}

/** The OAuth scopes a token carries: `scope` as a space-separated string (RFC 9068), or `scp` as a string or list. */
export function scopesOf(claims: Record<string, unknown>): string[] {
  const v = claims.scope ?? claims.scp;
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(" ") : [];
  return [...new Set(list.filter((s): s is string => typeof s === "string" && s.length > 0))];
}

/** A person or workload from verified OIDC claims (`verifyJwt`, `personOf`). Throws without `iss` and `sub`. */
export function fromOidcClaims(claims: JwtClaims, names: ClaimNames = {}): Principal {
  if (typeof claims.iss !== "string" || typeof claims.sub !== "string") throw new Error("claims need iss and sub");
  const n = { ...OIDC_CLAIMS, ...names };
  const email = firstText(claims, n.email);
  const name = firstText(claims, n.name);
  return {
    id: `oidc:${claims.iss}#${claims.sub}`,
    issuer: claims.iss,
    subject: claims.sub,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    groups: namesAt(claims, n.groups),
    roles: namesAt(claims, n.roles),
    scopes: scopesOf(claims),
    active: true,
  };
}

/** A SAML assertion's subject and attributes, after a SAML library or gateway has verified its signature. */
export interface SamlAssertion {
  /** The IdP's entity id. */
  issuer: string;
  nameId: string;
  attributes: Record<string, string | string[]>;
}

/**
 * A person from a verified SAML assertion. okayed doesn't check XML signatures itself: put Cloudflare Access (or any
 * SAML-to-OIDC broker) in front, or verify with a SAML library and pass what it read.
 */
export function fromSamlAssertion(a: SamlAssertion, names: ClaimNames = {}): Principal {
  const n = { ...SAML_ATTRIBUTES, ...names };
  const email = firstText(a.attributes, n.email) ?? (a.nameId.includes("@") ? a.nameId : undefined);
  const name = firstText(a.attributes, n.name);
  return {
    id: `saml:${a.issuer}#${a.nameId}`,
    issuer: a.issuer,
    subject: a.nameId,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    groups: namesAt(a.attributes, n.groups),
    roles: namesAt(a.attributes, n.roles),
    scopes: [],
    active: true,
  };
}

/** What Cloudflare Access says about a signed-in person at `/cdn-cgi/access/get-identity`. */
export interface AccessIdentity {
  user_uuid?: string;
  id?: string;
  email?: string;
  name?: string;
  /** Groups from the identity provider, including SAML and SCIM-synced ones, as objects or names. */
  groups?: (string | { id?: string; name?: string; email?: string })[];
  idp?: { id?: string; type?: string };
  [k: string]: unknown;
}

/**
 * A person signed in through Cloudflare Access, with the groups their identity provider sent: Okta, Entra, Google
 * Workspace, or any SAML or OIDC IdP Access is set up with. The subject is the one in their Access token.
 */
export function fromAccessIdentity(identity: AccessIdentity, team: string): Principal {
  const subject = identity.user_uuid ?? identity.id;
  if (!subject) throw new Error("the Access identity has no user id");
  const issuer = `https://${team}.cloudflareaccess.com`;
  return {
    id: `oidc:${issuer}#${subject}`,
    issuer,
    subject,
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.name ? { name: identity.name } : {}),
    groups: [...new Set((identity.groups ?? []).map((g) => groupName(typeof g === "string" ? g : g.name ?? g.email ?? g.id)).filter((g): g is string => !!g))],
    roles: [],
    scopes: [],
    active: true,
  };
}

/** Asks Cloudflare Access who holds this Access token (the `CF_Authorization` cookie's value), groups included. */
export async function accessIdentity(team: string, token: string, f: typeof fetch = fetch): Promise<AccessIdentity | null> {
  const r = await f(`https://${team}.cloudflareaccess.com/cdn-cgi/access/get-identity`, { headers: { cookie: `CF_Authorization=${token}` } });
  if (!r.ok) return null;
  return (await r.json()) as AccessIdentity;
}
