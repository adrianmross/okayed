import { describe, expect, it } from "vitest";
import { CloudflarePagesDeployer } from "../src/cloudflare.ts";

const NOW = 1_761_735_600;
const SITES = { "okayed.dev": { project: "okayed-site", branches: { production: "main", staging: "staging" } } };

/** A stand-in for the Cloudflare API that records every call. */
function cloudflare(opts: { deployFails?: boolean } = {}) {
  const calls: { method: string; path: string; auth: string; body: unknown }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const path = url.replace("https://api.cloudflare.com/client/v4", "");
    const body = init.body instanceof FormData ? Object.fromEntries(init.body) : init.body ? JSON.parse(String(init.body)) : undefined;
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

describe("real deploys with just-in-time Cloudflare API tokens", () => {
  it("mints a Pages-only token that dies with the grant, deploys with it, then deletes it", async () => {
    const cf = cloudflare();
    const d = new CloudflarePagesDeployer({ accountId: "acct", token: "parent", sites: SITES, fetch: cf.f, now: () => NOW });
    expect(await d.deploy({ host: "okayed.dev", env: "staging" }, NOW + 300)).toEqual({ id: "dep-1", url: "https://abc.okayed-site.pages.dev" });

    const mint = cf.calls.find((c) => c.method === "POST" && c.path === "/accounts/acct/tokens")!;
    expect(mint.auth).toBe("Bearer parent");
    expect(mint.body).toMatchObject({
      policies: [{ effect: "allow", resources: { "com.cloudflare.api.account.acct": "*" }, permission_groups: [{ id: "g-write" }] }],
      expires_on: new Date((NOW + 300) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    const deploy = cf.calls.find((c) => c.path.includes("/pages/projects/"))!;
    expect(deploy).toMatchObject({ path: "/accounts/acct/pages/projects/okayed-site/deployments", auth: "Bearer child-secret", body: { branch: "staging" } });
    expect(cf.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/accounts/acct/tokens/tok-1", auth: "Bearer parent" });
  });

  it("never lets the token outlive ten minutes, even under a longer grant", async () => {
    const cf = cloudflare();
    await new CloudflarePagesDeployer({ accountId: "acct", token: "parent", sites: SITES, permissionGroup: "g-write", fetch: cf.f, now: () => NOW }).deploy({ host: "okayed.dev", env: "production" }, NOW + 7200);
    const mint = cf.calls.find((c) => c.method === "POST" && c.path === "/accounts/acct/tokens")!;
    expect((mint.body as { expires_on: string }).expires_on).toBe(new Date((NOW + 600) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"));
    expect(cf.calls.some((c) => c.path.endsWith("/permission_groups"))).toBe(false);
  });

  it("deletes the token even when the deploy fails", async () => {
    const cf = cloudflare({ deployFails: true });
    const d = new CloudflarePagesDeployer({ accountId: "acct", token: "parent", sites: SITES, fetch: cf.f, now: () => NOW });
    await expect(d.deploy({ host: "okayed.dev", env: "production" }, NOW + 300)).rejects.toThrow(/build failed/);
    expect(cf.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/accounts/acct/tokens/tok-1" });
  });

  it("refuses a site or environment it doesn't manage, before minting anything", async () => {
    const cf = cloudflare();
    const d = new CloudflarePagesDeployer({ accountId: "acct", token: "parent", sites: SITES, fetch: cf.f, now: () => NOW });
    await expect(d.deploy({ host: "openmeadow.org", env: "production" }, NOW + 300)).rejects.toThrow(/isn't a Pages deployment/);
    await expect(d.deploy({ host: "okayed.dev", env: "preview" }, NOW + 300)).rejects.toThrow(/isn't a Pages deployment/);
    expect(cf.calls).toEqual([]);
  });
});
