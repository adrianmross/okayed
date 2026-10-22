import { describe, expect, it } from "vitest";
import { buildGrant, deriveIssuerKey, grantEvent, grantId, jcs, KIND, openGrantEvent, publicKeyOf, verifyEvent, hexToBytes, signEvent } from "../src/index.ts";
import type { GrantDraft } from "@okayed/engine";

const SK = deriveIssuerKey(hexToBytes("11".repeat(32)), "user-1");
const ISS = publicKeyOf(SK);
const draft: GrantDraft = {
  aud: "agent:assistant",
  act: "github.pr.merge",
  res: ["github:adrianmross/okayed/pull/182@3f9a1c2e4b5d6f708192a3b4c5d6e7f801234567"],
  when: [],
  nbf: 1761735600,
  exp: 1761736500,
  uses: 1,
  risk: "high",
  from: { utterance: "I approve merging #182", request: "r_1" },
};

describe("jcs", () => {
  it("sorts keys and drops whitespace", () => {
    expect(jcs({ b: 1, a: [true, null, "x"], c: { z: 1, y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
  });
  it("matches RFC 8785 number and string examples", () => {
    expect(jcs([1e21, 0.000001, -0, 333333333.3333333])).toBe("[1e+21,0.000001,0,333333333.3333333]");
    expect(jcs({ "€": 1, "\r": 2, "1": 3 })).toBe('{"\\r":2,"1":3,"€":1}');
  });
  it("rejects non-finite numbers", () => {
    expect(() => jcs({ x: Infinity })).toThrow();
  });
});

describe("grants", () => {
  const g = buildGrant(draft, ISS, { method: "web-click", at: 1761735598 }, "b3a9e0f1c2d34e5f");
  const ev = grantEvent(g, SK);

  it("derives a stable per-user issuer key", () => {
    expect(publicKeyOf(deriveIssuerKey(hexToBytes("11".repeat(32)), "user-1"))).toBe(ISS);
    expect(publicKeyOf(deriveIssuerKey(hexToBytes("11".repeat(32)), "user-2"))).not.toBe(ISS);
  });

  it("ids are the hash of the JCS body", () => {
    expect(g.id).toBe(grantId(g));
    expect(g.id).toMatch(/^[0-9a-f]{64}$/);
    expect(buildGrant(draft, ISS, { method: "web-click", at: 1761735598 }, "other-nonce").id).not.toBe(g.id);
  });

  it("signs a verifiable 4841 event with NIP-40 expiration", () => {
    expect(ev.kind).toBe(KIND.grant);
    expect(ev.tags).toContainEqual(["expiration", "1761736500"]);
    expect(verifyEvent(ev)).toBe(true);
    const opened = openGrantEvent(ev, [ISS]);
    expect(opened.ok && opened.grant).toEqual(g);
  });

  it("refuses tampering", () => {
    const widened = { ...g, res: ["github:adrianmross/**"] };
    expect(openGrantEvent({ ...ev, content: jcs(widened) })).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
    // Re-signed by an attacker with their own key: valid signature, untrusted issuer.
    const evil = new Uint8Array(32).fill(7);
    const forged = signEvent({ kind: KIND.grant, created_at: ev.created_at, tags: ev.tags, content: jcs({ ...widened, iss: publicKeyOf(evil) }) }, evil);
    expect(openGrantEvent(forged, [ISS])).toMatchObject({ ok: false });
    // Re-signed by the issuer key with a stale id.
    const stale = signEvent({ kind: KIND.grant, created_at: ev.created_at, tags: ev.tags, content: jcs(widened) }, SK);
    expect(openGrantEvent(stale, [ISS])).toMatchObject({ ok: false, reason: expect.stringMatching(/id does not match/) });
  });

  it("refuses a mismatched expiration tag", () => {
    const bad = signEvent({ kind: KIND.grant, created_at: ev.created_at, tags: [["x", g.id], ["expiration", "9999999999"]], content: jcs(g) }, SK);
    expect(openGrantEvent(bad)).toMatchObject({ ok: false, reason: expect.stringMatching(/expiration/) });
  });

  it("never throws on junk", () => {
    for (const junk of [null, "x", {}, { ...ev, sig: "zz" }, { ...ev, tags: "nope" }]) expect(openGrantEvent(junk).ok).toBe(false);
  });
});
