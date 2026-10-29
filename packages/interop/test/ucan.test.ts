import { buildGrant } from "@okayed/grant";
import { describe, expect, it } from "vitest";
import { actionFor, commandFor, didKey, pubkeyOfDid, requestFromUcan, ucanForGrant } from "../src/index.ts";
import { NOW, SHA } from "./helpers.ts";

const ISSUER = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PR = `github:acme/web/pull/7@${SHA}`;

describe("UCAN", () => {
  it("names okayed's issuer key as a secp256k1 did:key, and back", () => {
    const did = didKey(ISSUER);
    expect(did).toMatch(/^did:key:zQ3s/);
    expect(pubkeyOfDid(did)).toBe(ISSUER);
    expect(didKey(`02${ISSUER}`)).toBe(did);
    expect(pubkeyOfDid(didKey(`03${ISSUER}`))).toBeNull();
    expect(pubkeyOfDid("did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK")).toBeNull();
    expect(() => didKey("abc")).toThrow(/32 bytes/);
  });

  it("maps actions to commands", () => {
    expect(commandFor("github.pr.merge")).toBe("/github/pr/merge");
    expect(actionFor("/slack/message/post")).toBe("slack.message.post");
  });

  it("writes a grant as a delegation from the person to the agent", () => {
    const g = buildGrant({ aud: "agent:ci", act: "github.pr.merge", res: [PR], when: [{ c: "checks.pass" }], nbf: NOW, exp: NOW + 900, uses: 1, risk: "high", from: { utterance: "", request: "r_1" } }, ISSUER, { method: "webauthn", at: NOW }, "00ff00ff00ff00ff");
    const d = ucanForGrant(g, { audience: "did:key:z6MkAgent" });
    expect(d).toMatchObject({ iss: didKey(ISSUER), sub: didKey(ISSUER), aud: "did:key:z6MkAgent", cmd: "/github/pr/merge", pol: [["==", ".res", PR]], nbf: NOW, exp: NOW + 900, meta: { okayed: { grant: g.id, uses: 1, risk: "high", when: [{ c: "checks.pass" }] } } });
    expect([...d.nonce]).toEqual([0, 255, 0, 255, 0, 255, 0, 255]);
    expect(requestFromUcan(d)).toEqual({ act: "github.pr.merge", res: [PR], nbf: NOW, exp: NOW + 900 });
    const two = ucanForGrant({ ...g, res: ["github:acme/web", "github:acme/api"], act: "github.read" }, { audience: "did:key:z6MkAgent" });
    expect(requestFromUcan(two).res).toEqual(["github:acme/web", "github:acme/api"]);
  });

  it("reads only exact policies: a glob or a powerline is refused, never approximated", () => {
    const base = { cmd: "/github/read", sub: "did:key:zQ3sx", exp: null };
    expect(() => requestFromUcan({ ...base, pol: [["like", ".res", "github:acme/*"]] })).toThrow(/only exact policies/);
    expect(() => requestFromUcan({ ...base, pol: [] })).toThrow(/only exact policies/);
    expect(() => requestFromUcan({ ...base, sub: null, pol: [["==", ".res", "github:acme/web"]] })).toThrow(/powerline/);
    expect(() => requestFromUcan({ ...base, cmd: "/", pol: [["==", ".res", "github:acme/web"]] })).toThrow(/isn't an okayed action/);
  });
});
