import { handleApi, settle } from "@okayed/core";
import { openGrantEvent, type NostrEvent } from "@okayed/grant";
import { describe, expect, it } from "vitest";
import { detailsForGrant, paymentInitiation, readOkayedDetail, readRichRequests, requestsFromDetails } from "../src/index.ts";
import { SHA, person } from "./helpers.ts";

const PR = `github:acme/web/pull/7@${SHA}`;

describe("rich authorization requests (RFC 9396)", () => {
  it("read okayed's own type, one request per action", () => {
    expect(requestsFromDetails([
      { type: "okayed", actions: ["github.pr.merge"], identifier: PR },
      { type: "okayed", actions: ["github.read"], identifier: "github:acme/web" },
      { type: "okayed", actions: ["github.read"], identifier: "github:acme/api" },
    ])).toEqual([
      { act: "github.pr.merge", res: [PR] },
      { act: "github.read", res: ["github:acme/web", "github:acme/api"] },
    ]);
  });

  it("read RFC 9396's payment example as spending up to its amount", () => {
    const rfc = { type: "payment_initiation", actions: ["initiate", "status", "cancel"], locations: ["https://example.com/payments"], instructedAmount: { currency: "EUR", amount: "123.50" }, creditorName: "Merchant A", creditorAccount: { iban: "DE02100100109307118603" } };
    expect(requestsFromDetails([rfc], [readOkayedDetail, paymentInitiation({ account: "ops" })])).toEqual([{ act: "spend.money", res: ["money:ops/EUR/123.5"] }]);
  });

  it("refuse what they can't read, rather than okay less than was asked", () => {
    expect(() => requestsFromDetails([{ type: "account_information", actions: ["list_accounts"] }])).toThrow(/no reader for type "account_information"/);
    expect(() => requestsFromDetails([{ type: "okayed", actions: ["github.pr.merge"], identifier: "github:acme/**" }])).toThrow(/not an exact resource/);
    expect(() => requestsFromDetails([])).toThrow(/non-empty list/);
  });

  it("let an agent ask in authorization_details, and write the grant back as them", async () => {
    const { svc, owner, token } = await person();
    const call = (path: string, auth: string, body?: unknown) =>
      handleApi(svc, new Request(`http://x${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${auth}` }, ...(body ? { body: JSON.stringify(body) } : {}) }), path, { readRequest: readRichRequests() });
    const asked = await (await call("/requests", token, { why: "release", authorization_details: [{ type: "okayed", actions: ["github.pr.merge"], identifier: PR }] })).json() as { request: { id: string; act: string }; cardId: string };
    expect(asked.request.act).toBe("github.pr.merge");
    const two = await call("/requests", token, { authorization_details: [{ type: "okayed", actions: ["github.read"], identifier: "github:acme/web" }, { type: "okayed", actions: ["github.pr.merge"], identifier: PR }] });
    expect([two.status, (await two.json() as { error: string }).error]).toEqual([400, "one request asks for one action; these ask for github.read and github.pr.merge"]);
    await call(`/cards/${asked.cardId}/confirm`, owner, {});
    await settle();
    const st = await (await call(`/requests/${asked.request.id}`, token)).json() as { grant: NostrEvent };
    const opened = openGrantEvent(st.grant, [svc.issuer]);
    if (!opened.ok) throw new Error(opened.reason);
    expect(detailsForGrant(opened.grant, { location: "https://api.github.com" })).toEqual([
      { type: "okayed", actions: ["github.pr.merge"], identifier: PR, locations: ["https://api.github.com"], okayed: { grant: opened.grant.id, iss: svc.issuer, exp: opened.grant.exp, uses: 1 } },
    ]);
  });
});
