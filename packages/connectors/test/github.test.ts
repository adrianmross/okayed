import { performWithGrant, staticCredential } from "@okayed/core";
import { settle } from "@okayed/core";
import { describe, expect, it } from "vitest";
import { githubAppCredential, githubMerge } from "../src/index.ts";
import { NOW, okayed } from "./helpers.ts";

const SHA = "3f9a1c2e4b5d6f708192a3b4c5d6e7f801234567";
const PR = `github:adrianmross/okayed/pull/182@${SHA}`;
const body = (grant: unknown) => ({ grant, owner: "adrianmross", repo: "okayed", number: 182, sha: SHA });

function github(checks: "success" | "failure" = "success") {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.includes("/check-runs")) return Response.json({ check_runs: [{ status: "completed", conclusion: checks }] });
    if (url.endsWith("/merge")) return Response.json({ sha: "merged123", merged: true });
    if (url.includes("/access_tokens")) return Response.json({ token: "ghs_minted", expires_at: "2099-01-01T00:00:00Z" }, { status: 201 });
    if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { calls, f };
}

describe("GitHub merge connector", () => {
  it("merges with the credential only under a live grant, pinned to the commit, and only once", async () => {
    const { svc, agent, grant } = await okayed();
    const gh = github();
    const merge = githubMerge({ credential: staticCredential("ghp_secret"), fetch: gh.f });
    expect(await performWithGrant(svc, merge, body(null), agent)).toMatchObject({ ok: false, stage: "grant" });
    expect(gh.calls.some((c) => c.url.endsWith("/merge"))).toBe(false);

    const g = await grant("github.pr.merge", [PR]);
    expect(await performWithGrant(svc, merge, body(g), agent)).toMatchObject({ ok: true, merged: true, sha: "merged123", left: 0 });
    const call = gh.calls.find((c) => c.url.endsWith("/merge"))!;
    expect(JSON.parse(String(call.init!.body))).toMatchObject({ sha: SHA });
    expect(new Headers(call.init!.headers).get("authorization")).toBe("Bearer ghp_secret");
    expect(await performWithGrant(svc, merge, body(g), agent)).toMatchObject({ ok: false, stage: "grant", reason: expect.stringMatching(/one use/) });
  });

  it("doesn't spend the use when a condition fails", async () => {
    const { svc, agent } = await okayed();
    await svc.submitRequest(agent, { act: "github.pr.merge", res: [PR] });
    const card = await svc.chat("merge #182 once CI passes");
    await svc.confirm(card.id);
    await settle();
    const g = (await svc.snapshot()).grants[0]!;
    const out = await performWithGrant(svc, githubMerge({ credential: staticCredential("t"), fetch: github("failure").f }), body(g.event), agent);
    expect(out).toMatchObject({ ok: false, stage: "grant", reason: expect.stringMatching(/checks have not passed/) });
    expect((await svc.snapshot()).grants[0]!.used).toBe(0);
  });

  it("refuses malformed input before touching anything", async () => {
    const { svc, agent } = await okayed();
    const out = await performWithGrant(svc, githubMerge({ credential: staticCredential("t"), fetch: github().f }), { grant: null, owner: "a", repo: "b", number: 1, sha: "short" }, agent);
    expect(out).toMatchObject({ ok: false, stage: "input" });
  });

  it("can act with a GitHub App token minted for just that repository, then revoked", async () => {
    const { svc, agent, grant } = await okayed();
    const gh = github();
    const k = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey("pkcs8", k.privateKey)).toString("base64")}\n-----END PRIVATE KEY-----`;
    const credential = githubAppCredential({ appId: "123", privateKey: pem, installationId: "456", permissions: { pull_requests: "write", contents: "write", checks: "read" }, fetch: gh.f, now: () => NOW });
    const g = await grant("github.pr.merge", [PR]);
    expect(await performWithGrant(svc, githubMerge({ credential, fetch: gh.f }), body(g), agent)).toMatchObject({ ok: true, merged: true });

    const mint = gh.calls.find((c) => c.url.endsWith("/app/installations/456/access_tokens"))!;
    expect(JSON.parse(String(mint.init!.body))).toEqual({ repositories: ["okayed"], permissions: { pull_requests: "write", contents: "write", checks: "read" } });
    const appJwt = new Headers(mint.init!.headers).get("authorization")!.slice(7);
    const [h, p, s] = appJwt.split(".");
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", k.publicKey, Buffer.from(s!, "base64url"), new TextEncoder().encode(`${h}.${p}`));
    expect(ok).toBe(true);
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toMatchObject({ iss: "123" });
    expect(new Headers(gh.calls.find((c) => c.url.endsWith("/merge"))!.init!.headers).get("authorization")).toBe("Bearer ghs_minted");
    expect(gh.calls.at(-1)).toMatchObject({ url: "https://api.github.com/installation/token", init: { method: "DELETE" } });
  });
});
