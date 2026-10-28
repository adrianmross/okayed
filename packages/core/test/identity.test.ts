import { describe, expect, it } from "vitest";
import {
  HeuristicDrafter,
  InlineLifecycle,
  KeySigner,
  ManualClock,
  MemoryStore,
  OkayedService,
  cloudflareAccess,
  cryptoRandom,
  oidcBearer,
  personOf,
  subjectMatches,
  userForSubject,
  verifyJwt,
} from "../src/index.ts";

const NOW = Math.floor(Date.now() / 1000);
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

/** A tiny OIDC issuer: its keys, its discovery document, and tokens it signs. */
async function issuer(url: string, alg: "RS256" | "ES256" = "RS256") {
  const params = alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } : { name: "ECDSA", namedCurve: "P-256" };
  const k = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", k.publicKey)), kid: `${alg}-1` };
  const sign = async (claims: Record<string, unknown>) => {
    const h = enc({ alg, kid: jwk.kid });
    const p = enc({ iss: url, iat: NOW, exp: NOW + 300, ...claims });
    const sig = await crypto.subtle.sign(alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" }, k.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
  };
  const f = (async (u: string) => {
    if (u === `${url}/.well-known/openid-configuration`) return Response.json({ issuer: url, jwks_uri: `${url}/jwks` });
    if (u === `${url}/jwks` || u === `${url}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { sign, fetch: f };
}

describe("JWTs from any OIDC issuer", () => {
  it("verifies RS256 and ES256 tokens found by discovery, and checks issuer, audience and time", async () => {
    for (const alg of ["RS256", "ES256"] as const) {
      const idp = await issuer(`https://${alg.toLowerCase()}.example`, alg);
      const check = { issuer: `https://${alg.toLowerCase()}.example`, audience: "okayed", fetch: idp.fetch };
      expect((await verifyJwt(await idp.sign({ sub: "u1", aud: "okayed" }), check))?.sub).toBe("u1");
      expect(await verifyJwt(await idp.sign({ sub: "u1", aud: "someone-else" }), check)).toBeNull();
      expect(await verifyJwt(await idp.sign({ sub: "u1", aud: "okayed", exp: NOW - 1 }), check)).toBeNull();
      expect(await verifyJwt(await idp.sign({ sub: "u1", aud: "okayed", iss: "https://evil.example" }), check)).toBeNull();
    }
  });

  it("refuses a token signed by another key, even with the right claims", async () => {
    const real = await issuer("https://idp.example");
    const fake = await issuer("https://idp.example");
    expect(await verifyJwt(await fake.sign({ sub: "u1", aud: "okayed" }), { issuer: "https://idp.example", audience: "okayed", fetch: real.fetch })).toBeNull();
  });

  it("finds the person behind Cloudflare Access or any OIDC bearer token, and maps them to one stable okayed", async () => {
    const access = await issuer("https://acme.cloudflareaccess.com");
    const token = await access.sign({ sub: "person-1", aud: ["app-aud"], email: "ada@example.com" });
    const viaHeader = await personOf(new Request("https://x/", { headers: { "cf-access-jwt-assertion": token } }), [cloudflareAccess("acme", "app-aud")], access.fetch);
    const viaCookie = await personOf(new Request("https://x/", { headers: { cookie: `a=1; CF_Authorization=${token}` } }), [cloudflareAccess("acme", "app-aud")], access.fetch);
    expect(viaHeader?.userId).toBe(await userForSubject("https://acme.cloudflareaccess.com", "person-1"));
    expect(viaCookie?.userId).toBe(viaHeader?.userId);
    // An Access service token is a machine, not a person.
    const service = await access.sign({ sub: "", common_name: "ci.access", aud: ["app-aud"] });
    expect(await personOf(new Request("https://x/", { headers: { "cf-access-jwt-assertion": service } }), [cloudflareAccess("acme", "app-aud")], access.fetch)).toBeNull();

    const auth0 = await issuer("https://tenant.auth0.example");
    const id = await auth0.sign({ sub: "auth0|42", aud: "okayed-app" });
    expect((await personOf(new Request("https://x/", { headers: { authorization: `Bearer ${id}` } }), [oidcBearer("https://tenant.auth0.example", "okayed-app")], auth0.fetch))?.userId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("matches workload subjects exactly or with wildcards", () => {
    expect(subjectMatches("repo:adrianmross/okayed:ref:refs/heads/main", "repo:adrianmross/okayed:ref:refs/heads/main")).toBe(true);
    expect(subjectMatches("repo:adrianmross/okayed:*", "repo:adrianmross/okayed:pull_request")).toBe(true);
    expect(subjectMatches("repo:adrianmross/okayed:*", "repo:adrianmross/other:ref:refs/heads/main")).toBe(false);
    expect(subjectMatches("repo:a.b/c:ref", "repo:aXb/c:ref")).toBe(false);
  });
});

describe("agents by workload identity", () => {
  it("lets a trusted CI job act as an agent with its platform token, and nobody else", async () => {
    const gha = await issuer("https://token.actions.githubusercontent.com");
    const clock = new ManualClock(NOW);
    const lifecycle = new InlineLifecycle(clock);
    const svc = new OkayedService({ userId: "u1", store: new MemoryStore(), clock, signer: KeySigner.forUser("22".repeat(32), "u1"), drafter: new HeuristicDrafter(), lifecycle, random: cryptoRandom, fetch: gha.fetch });
    lifecycle.target = svc;
    await svc.claim();
    const { id } = await svc.trustWorkload({ issuer: "https://token.actions.githubusercontent.com", subject: "repo:adrianmross/okayed:ref:refs/heads/main", audience: "https://okayed.example", name: "release workflow" });
    expect(id).toBe("agent:release-workflow");

    const main = await gha.sign({ sub: "repo:adrianmross/okayed:ref:refs/heads/main", aud: "https://okayed.example" });
    expect(await svc.agentFor(main)).toBe("agent:release-workflow");
    const fork = await gha.sign({ sub: "repo:someone/okayed:ref:refs/heads/main", aud: "https://okayed.example" });
    expect(await svc.agentFor(fork)).toBeNull();
    const elsewhere = await gha.sign({ sub: "repo:adrianmross/okayed:ref:refs/heads/main", aud: "https://other.example" });
    expect(await svc.agentFor(elsewhere)).toBeNull();

    // The agent asks like any other, and shows up with what it trusts.
    const r = await svc.submitRequest("agent:release-workflow", { act: "github.read", res: ["github:adrianmross/okayed"], why: "release notes" });
    expect(r.request.aud).toBe("agent:release-workflow");
    expect((await svc.snapshot()).agents.find((a) => a.id === id)?.workload?.subject).toBe("repo:adrianmross/okayed:ref:refs/heads/main");
  });

  it("refuses a trust that would cover every workload of an issuer", async () => {
    const svc = new OkayedService({ userId: "u2", store: new MemoryStore(), clock: new ManualClock(NOW), signer: KeySigner.forUser("22".repeat(32), "u2"), drafter: new HeuristicDrafter(), lifecycle: new InlineLifecycle(new ManualClock(NOW)), random: cryptoRandom });
    await expect(svc.trustWorkload({ issuer: "https://token.actions.githubusercontent.com", subject: "*", audience: "x" })).rejects.toThrow(/every workload/);
    await expect(svc.trustWorkload({ issuer: "http://insecure.example", subject: "a", audience: "x" })).rejects.toThrow(/https/);
  });
});
