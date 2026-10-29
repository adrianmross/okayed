import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { okayedServer } from "../src/server.ts";
import { SqliteStore } from "../src/sqlite.ts";

describe("SqliteStore", () => {
  it("keeps people apart, and commits a transaction whole or not at all", async () => {
    const db = new DatabaseSync(":memory:");
    const a = new SqliteStore(db, "a");
    const b = new SqliteStore(db, "b");
    await a.put("k", 1);
    expect(await b.get("k")).toBeUndefined();
    await expect(
      a.transaction(async (tx) => {
        await tx.put("k", 2);
        await tx.put("other", 3);
        expect(await tx.get("k")).toBe(2);
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(await a.get("k")).toBe(1);
    expect(await a.get("other")).toBeUndefined();
    await a.transaction(async (tx) => {
      await tx.put("p:2", "two");
      await tx.put("p:1", "one");
      await tx.delete("k");
      expect([...(await tx.list("p:")).keys()]).toEqual(["p:1", "p:2"]);
    });
    expect(await a.get("k")).toBeUndefined();
    expect([...(await a.list<string>("p:")).values()]).toEqual(["one", "two"]);
  });

  it("runs one person's transactions one at a time", async () => {
    const s = new SqliteStore(new DatabaseSync(":memory:"), "u");
    await s.put("n", 0);
    await Promise.all(
      Array.from({ length: 20 }, () =>
        s.transaction(async (tx) => {
          const n = (await tx.get<number>("n"))!;
          await new Promise((r) => setTimeout(r, 1));
          await tx.put("n", n + 1);
        }),
      ),
    );
    expect(await s.get("n")).toBe(20);
  });
});

describe("okayed on Node", () => {
  const server = okayedServer({ secret: "44".repeat(32), db: ":memory:" });
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => void server.close());

  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };

  it("serves the same API: a request, the person's okay, a signed grant, one use", async () => {
    const { body: me } = await call("POST", "/api/users");
    const u = `/api/u/${me.userId}`;
    await call("PUT", `${u}/policy`, me.ownerToken, { rules: [] });
    const { body: agent } = await call("POST", `${u}/agents`, me.ownerToken, { name: "ci" });
    const res = "github:adrianmross/okayed";
    const { status, body: asked } = await call("POST", `${u}/requests`, agent.token, { act: "github.read", res: [res], why: "release notes" });
    expect([status, asked.status]).toEqual([202, "pending"]);
    await call("POST", `${u}/cards/${asked.cardId}/confirm`, me.ownerToken);
    let st: Record<string, any> = {};
    for (let i = 0; i < 20 && st.status !== "granted"; i++) st = (await call("GET", `${u}/requests/${asked.request.id}?wait=1`, agent.token)).body;
    expect(st.grant.kind).toBe(4841);
    const use = { event: st.grant, aud: agent.id, act: "github.read", res, consume: true };
    expect((await call("POST", `${u}/verify`, undefined, use)).body.ok).toBe(true);
    expect((await call("GET", `${u}/state`, "own_wrong")).status).toBe(401);
    expect((await call("GET", `/api/u/${"0".repeat(32)}/state`, me.ownerToken)).status).toBe(404);
  });
});

describe("an organization on Node: OIDC sign-in, SCIM, and rich requests", async () => {
  const { createServer } = await import("node:http");
  // A tiny OIDC issuer: discovery, a JWKS, and ID tokens signed with its RSA key.
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", use: "sig", alg: "RS256" };
  let issuer = "";
  const idp = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/openid-configuration") return void res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
    if (req.url === "/jwks") return void res.end(JSON.stringify({ keys: [jwk] }));
    res.statusCode = 404;
    res.end("{}");
  });
  const b64 = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
  const idToken = async (sub: string, extra: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const head = `${b64(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }))}.${b64(JSON.stringify({ iss: issuer, aud: "okayed", sub, iat: now, exp: now + 600, ...extra }))}`;
    return `${head}.${b64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(head))))}`;
  };

  const policy = { name: "Acme", default: "deny" as const, grants: [{ to: "*", effect: "allow" as const, act: "github.read" }, { to: "release-managers", effect: "allow" as const, act: "github.pr.merge", res: "github:acme/**" }] };
  let base = "";
  let server: ReturnType<typeof okayedServer>;
  let plain: ReturnType<typeof okayedServer>;
  let plainBase = "";
  beforeAll(async () => {
    await new Promise<void>((r) => idp.listen(0, r));
    issuer = `http://localhost:${(idp.address() as AddressInfo).port}`;
    server = okayedServer({ secret: "55".repeat(32), oidc: { issuer, audience: "okayed" }, org: { policy, scimToken: "scim-test" } });
    plain = okayedServer({ secret: "66".repeat(32), oidc: { issuer, audience: "okayed" }, org: { policy } });
    await new Promise<void>((r) => server.listen(0, r));
    await new Promise<void>((r) => plain.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    plainBase = `http://localhost:${(plain.address() as AddressInfo).port}`;
  });
  afterAll(() => void [server, plain, idp].forEach((s) => s.close()));

  const call = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await fetch(url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (r.status === 204 ? {} : await r.json()) as Record<string, any> };
  };
  const PR = "github:acme/web/pull/7@3f9a1c2e4b5d6f708192a3b4c5d6e7f801234567";

  it("provisions a person before they sign in, follows their groups, and stops them when they're removed", async () => {
    const scim = (method: string, path: string, body?: unknown) => call(method, `${base}/scim/v2${path}`, "scim-test", body);
    expect((await call("GET", `${base}/scim/v2/Users`, "wrong")).status).toBe(401);
    const ada = (await scim("POST", "/Users", { userName: "ada@acme.dev", externalId: "00u1" })).body;

    // Ada signs in with her ID token; her okayed already has Acme's limits.
    const token = await idToken("00u1");
    const me = (await call("POST", `${base}/api/users`, token)).body;
    const u = `${base}/api/u/${me.userId}`;
    await call("PUT", `${u}/policy`, token, { rules: [] });
    const { body: agent } = await call("POST", `${u}/agents`, token, { name: "ci" });
    expect((await call("POST", `${u}/requests`, agent.token, { act: "github.pr.merge", res: [PR], why: "release" })).body).toMatchObject({ status: "denied", reason: "Refused by Acme: nothing here covers github.pr.merge." });

    // Acme makes her a release manager; her agent asks in RFC 9396's words, and she okays it.
    const group = (await scim("POST", "/Groups", { displayName: "Release-Managers", members: [{ value: ada.id }] })).body;
    expect(group.members).toHaveLength(1);
    const asked = (await call("POST", `${u}/requests`, agent.token, { why: "release", authorization_details: [{ type: "okayed", actions: ["github.pr.merge"], identifier: PR }] })).body;
    expect(asked.status).toBe("pending");
    await call("POST", `${u}/cards/${asked.cardId}/confirm`, token);
    let st: Record<string, any> = {};
    for (let i = 0; i < 20 && st.status !== "granted"; i++) st = (await call("GET", `${u}/requests/${asked.request.id}?wait=1`, agent.token)).body;
    expect(st.status).toBe("granted");

    // Acme removes her: the merge she okayed is taken back at once.
    expect((await scim("DELETE", `/Users/${ada.id}`)).status).toBe(204);
    const state = (await call("GET", `${u}/state`, token)).body;
    expect(state.grants.map((g: { status: string; revokeReason: string }) => [g.status, g.revokeReason])).toEqual([["revoked", "removed from Acme's directory"]]);
    expect(state.policy.described[0].layer).toBe("Acme");
  });

  it("without a directory, takes each person's limits from the groups in their sign-in token", async () => {
    // Acme lets release managers merge, and the default rules let checked merges go ahead: so it does.
    const lead = await idToken("00u9", { groups: ["Release-Managers"] });
    const me = (await call("POST", `${plainBase}/api/users`, lead)).body;
    const u = `${plainBase}/api/u/${me.userId}`;
    const { body: agent } = await call("POST", `${u}/agents`, lead, { name: "ci" });
    expect((await call("POST", `${u}/requests`, agent.token, { act: "github.pr.merge", res: [PR], why: "x" })).body.status).toBe("approving");
    const other = await idToken("00u8");
    const them = (await call("POST", `${plainBase}/api/users`, other)).body;
    const { body: theirs } = await call("POST", `${plainBase}/api/u/${them.userId}/agents`, other, { name: "ci" });
    expect((await call("POST", `${plainBase}/api/u/${them.userId}/requests`, theirs.token, { act: "github.pr.merge", res: [PR], why: "x" })).body.status).toBe("denied");
    expect((await call("GET", `${plainBase}/scim/v2/Users`, "anything")).status).toBe(404);
  });
});
