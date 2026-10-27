import { describe, expect, it } from "vitest";
import { accessIdentity, userForIdentity } from "../src/access.ts";

const TEAM = "acme";
const AUD = "aud-tag-123";
const NOW = 1_761_735_600;

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

async function keypair() {
  const k = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", k.publicKey)), kid: "k1" };
  return { k, jwk };
}

async function jwt(k: CryptoKeyPair, claims: Record<string, unknown>, kid = "k1") {
  const head = enc({ alg: "RS256", kid });
  const body = enc(claims);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString("base64url")}`;
}

const good = { aud: [AUD], iss: `https://${TEAM}.cloudflareaccess.com`, sub: "user-1", email: "ada@example.com", exp: NOW + 600 };

describe("Cloudflare Access", async () => {
  const { k, jwk } = await keypair();
  const certs = (async () => Response.json({ keys: [jwk] })) as unknown as typeof fetch;
  const req = (token: string, cookie = false) => new Request("https://okayed.example/api/me", { headers: cookie ? { cookie: `x=1; CF_Authorization=${token}` } : { "cf-access-jwt-assertion": token } });

  it("accepts a JWT Access signed for this application, from the header or the cookie", async () => {
    const t = await jwt(k, good);
    expect(await accessIdentity(req(t), TEAM, AUD, NOW, certs)).toEqual({ sub: "user-1", email: "ada@example.com" });
    expect((await accessIdentity(req(t, true), TEAM, AUD, NOW, certs))?.sub).toBe("user-1");
  });

  it("refuses another application's audience, another team, an expired token, and a forged signature", async () => {
    expect(await accessIdentity(req(await jwt(k, { ...good, aud: ["other"] })), TEAM, AUD, NOW, certs)).toBeNull();
    expect(await accessIdentity(req(await jwt(k, { ...good, iss: "https://evil.cloudflareaccess.com" })), TEAM, AUD, NOW, certs)).toBeNull();
    expect(await accessIdentity(req(await jwt(k, { ...good, exp: NOW - 1 })), TEAM, AUD, NOW, certs)).toBeNull();
    const other = await keypair();
    expect(await accessIdentity(req(await jwt(other.k, good)), TEAM, AUD, NOW, certs)).toBeNull();
    expect(await accessIdentity(new Request("https://okayed.example/"), TEAM, AUD, NOW, certs)).toBeNull();
  });

  it("knows a service token by its common name", async () => {
    const t = await jwt(k, { aud: AUD, iss: good.iss, sub: "", common_name: "abc.access", exp: NOW + 60 });
    expect(await accessIdentity(req(t), TEAM, AUD, NOW, certs)).toEqual({ sub: "abc.access", commonName: "abc.access" });
  });

  it("maps one person to one stable okayed", async () => {
    const a = await userForIdentity(TEAM, { sub: "user-1" });
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await userForIdentity(TEAM, { sub: "user-1" })).toBe(a);
    expect(await userForIdentity(TEAM, { sub: "user-2" })).not.toBe(a);
  });
});
