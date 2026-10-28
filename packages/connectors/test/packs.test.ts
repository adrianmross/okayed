import { enablePacks, performWithGrant, staticCredential } from "@okayed/core";
import { beforeAll, describe, expect, it } from "vitest";
import { cloudflareDnsEdit, cloudflareToken, slackPost, zoneScope } from "../src/index.ts";
import { NOW, okayed } from "./helpers.ts";

beforeAll(() => enablePacks({ ids: "slack,cloudflare-dns" }));

describe("Slack connector", () => {
  it("posts to the granted channel with the bot token, once", async () => {
    const { svc, agent, grant } = await okayed();
    const calls: { url: string; body: Record<string, unknown>; auth: string }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization")! });
      return Response.json({ ok: true, ts: "1.2" });
    }) as typeof fetch;
    const post = slackPost({ workspace: "acme", credential: staticCredential("xoxb-bot"), fetch: f });
    const g = await grant("slack.message.post", ["slack:acme/releases"]);
    expect(await performWithGrant(svc, post, { grant: g, channel: "#general", text: "hi" }, agent)).toMatchObject({ ok: false, stage: "grant" });
    expect(await performWithGrant(svc, post, { grant: g, channel: "#releases", text: "1.4 is out" }, agent)).toMatchObject({ ok: true, posted: true, left: 0 });
    expect(calls).toEqual([{ url: "https://slack.com/api/chat.postMessage", body: { channel: "#releases", text: "1.4 is out" }, auth: "Bearer xoxb-bot" }]);
  });
});

describe("Cloudflare DNS connector", () => {
  it("changes one record with a token minted for just that zone", async () => {
    const { svc, agent, grant } = await okayed();
    const calls: { method: string; path: string; auth: string; body: unknown }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const path = url.replace("https://api.cloudflare.com/client/v4", "");
      calls.push({ method: init.method ?? "GET", path, auth: new Headers(init.headers).get("authorization")!, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
      if (path.endsWith("/tokens") && init.method === "POST") return ok({ id: "t1", value: "zone-token" });
      if (init.method === "DELETE") return ok({});
      if (path.startsWith("/zones/z9/dns_records?")) return ok([{ id: "rec1" }]);
      if (path === "/zones/z9/dns_records/rec1" && init.method === "PUT") return ok({ id: "rec1" });
      return Response.json({ success: false, errors: [{ message: "unexpected" }] }, { status: 404 });
    }) as typeof fetch;
    const credential = cloudflareToken({ accountId: "acct", token: "parent", permissions: ["4755a26eedb94da69e1066d98aa820be"], resources: zoneScope, fetch: f, now: () => NOW });
    const dns = cloudflareDnsEdit({ zones: { "okayed.dev": "z9" }, credential, fetch: f });
    const g = await grant("cloudflare.dns.edit", ["dns:okayed.dev/cname/www"]);
    const out = await performWithGrant(svc, dns, { grant: g, zone: "okayed.dev", type: "CNAME", name: "www", content: "okayed.pages.dev", proxied: true }, agent, NOW);
    expect(out).toMatchObject({ ok: true, changed: true, record: "rec1", name: "www.okayed.dev" });
    expect(calls[0]!.body).toMatchObject({ policies: [{ resources: { "com.cloudflare.api.account.zone.z9": "*" } }] });
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({ auth: "Bearer zone-token", body: { type: "CNAME", name: "www.okayed.dev", content: "okayed.pages.dev", proxied: true } });
    expect(calls.at(-1)!.method).toBe("DELETE");
  });

  it("refuses a zone it doesn't manage before minting anything", async () => {
    const { svc, agent } = await okayed();
    let minted = false;
    const credential = async () => ((minted = true), { token: "x" });
    const dns = cloudflareDnsEdit({ zones: { "okayed.dev": "z9" }, credential });
    expect(await performWithGrant(svc, dns, { grant: null, zone: "other.dev", type: "a", name: "@", content: "1.2.3.4" }, agent)).toMatchObject({ ok: false, stage: "input" });
    expect(minted).toBe(false);
  });
});
