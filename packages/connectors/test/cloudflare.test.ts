import { performWithGrant } from "@okayed/core";
import { describe, expect, it } from "vitest";
import { cloudflarePagesDeploy, cloudflareToken } from "../src/index.ts";
import { NOW, okayed } from "./helpers.ts";

const SITES = { "okayed.dev": { project: "okayed-site", branches: { production: "main", staging: "staging" } } };
const iso = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A stand-in for the Cloudflare API that records every call. */
function cloudflare(opts: { deployFails?: boolean } = {}) {
  const calls: { method: string; path: string; auth: string; body: unknown }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const path = url.replace("https://api.cloudflare.com/client/v4", "");
    const body = init.body instanceof FormData ? Object.fromEntries(init.body as unknown as Iterable<[string, unknown]>) : init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", path, auth: String((init.headers as Record<string, string>).authorization), body });
    const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
    if (path.endsWith("/tokens/permission_groups")) return ok([{ id: "g-read", name: "Pages Read" }, { id: "g-write", name: "Pages Write" }]);
    if (init.method === "POST" && path.endsWith("/tokens")) return ok({ id: "tok-1", value: "child-secret" });
    if (init.method === "DELETE") return ok({ id: "tok-1" });
    if (path.includes("/pages/projects/")) return opts.deployFails ? Response.json({ success: false, errors: [{ message: "build failed" }] }, { status: 400 }) : ok({ id: "dep-1", url: "https://abc.okayed-site.pages.dev" });
    return Response.json({ success: false, errors: [{ message: "unexpected" }] }, { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, f };
}

function deploy(cf: ReturnType<typeof cloudflare>) {
  const credential = cloudflareToken({ accountId: "acct", token: "parent", permissions: ["Pages Write"], fetch: cf.f, now: () => NOW });
  return cloudflarePagesDeploy({ accountId: "acct", sites: SITES, credential, fetch: cf.f });
}

describe("Cloudflare Pages with just-in-time API tokens", () => {
  it("mints a Pages-only token that dies with the grant, deploys with it, then deletes it", async () => {
    const { svc, agent, grant } = await okayed();
    const cf = cloudflare();
    const g = await grant("site.deploy", ["site:okayed.dev/staging"]);
    const exp = JSON.parse(g.content).exp as number;
    expect(await performWithGrant(svc, deploy(cf), { grant: g, site: "okayed.dev", env: "staging" }, agent, NOW)).toMatchObject({ ok: true, deployed: true, id: "dep-1", url: "https://abc.okayed-site.pages.dev", left: 0 });

    const mint = cf.calls.find((c) => c.method === "POST" && c.path === "/accounts/acct/tokens")!;
    expect(mint.auth).toBe("Bearer parent");
    expect(mint.body).toMatchObject({ policies: [{ effect: "allow", resources: { "com.cloudflare.api.account.acct": "*" }, permission_groups: [{ id: "g-write" }] }], expires_on: iso(Math.min(exp, NOW + 600)) });
    expect(cf.calls.find((c) => c.path.includes("/pages/projects/"))).toMatchObject({ path: "/accounts/acct/pages/projects/okayed-site/deployments", auth: "Bearer child-secret", body: { branch: "staging" } });
    expect(cf.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/accounts/acct/tokens/tok-1", auth: "Bearer parent" });
  });

  it("deletes the token even when the deploy fails, and the use stays spent", async () => {
    const { svc, agent, grant } = await okayed();
    const cf = cloudflare({ deployFails: true });
    const g = await grant("site.deploy", ["site:okayed.dev/production"]);
    expect(await performWithGrant(svc, deploy(cf), { grant: g, site: "okayed.dev", env: "production" }, agent, NOW)).toMatchObject({ ok: false, stage: "action", reason: expect.stringMatching(/build failed/) });
    expect(cf.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/accounts/acct/tokens/tok-1" });
  });

  it("refuses a site or environment it doesn't manage, before minting anything", async () => {
    const { svc, agent } = await okayed();
    const cf = cloudflare();
    expect(await performWithGrant(svc, deploy(cf), { grant: null, site: "openmeadow.org", env: "production" }, agent, NOW)).toMatchObject({ ok: false, stage: "input" });
    expect(cf.calls).toEqual([]);
  });

  it("can narrow a minted token to the resources a call touches", async () => {
    const cf = cloudflare();
    const zoneToken = cloudflareToken({ accountId: "acct", token: "parent", permissions: ["0123456789abcdef0123456789abcdef"], resources: (s) => ({ [`com.cloudflare.api.account.zone.${s?.zone}`]: "*" }), fetch: cf.f, now: () => NOW });
    await zoneToken({ until: NOW + 60, scope: { zone: "z1" } });
    expect(cf.calls[0]!.body).toMatchObject({ policies: [{ resources: { "com.cloudflare.api.account.zone.z1": "*" }, permission_groups: [{ id: "0123456789abcdef0123456789abcdef" }] }], expires_on: iso(NOW + 60) });
  });
});
