import { beforeEach, describe, expect, it } from "vitest";
import { openGrantEvent, publicKeyOf, signEvent, verifyEvent } from "@okayed/grant";
import {
  HeuristicDrafter,
  InlineLifecycle,
  KeySigner,
  ManualClock,
  MemoryStore,
  OkayedService,
  answerTemplate,
  cryptoRandom,
  settle,
  type Notifier,
  type PairedApprover,
  type PushedApproval,
} from "../src/index.ts";

const NOW = 1_761_735_600;
const PR = `github:adrianmross/okayed/pull/182@${"3f9a1c2e4b5d6f708192a3b4c5d6e7f801234567"}`;
const INBOX = "https://okayed.example/api/u/u1/approvers/inbox";
const PHONE = new Uint8Array(32).fill(7);
const STRANGER = new Uint8Array(32).fill(9);

let t: { svc: OkayedService; clock: ManualClock; woken: PairedApprover[] };
let agent: string;

beforeEach(async () => {
  const clock = new ManualClock(NOW);
  const lifecycle = new InlineLifecycle(clock);
  const woken: PairedApprover[] = [];
  const notifier: Notifier = { name: "test", notify: async (a) => void woken.push(a) };
  const svc = new OkayedService({ userId: "u1", store: new MemoryStore(), clock, signer: KeySigner.forUser("22".repeat(32), "u1"), drafter: new HeuristicDrafter(), lifecycle, random: cryptoRandom, notifier });
  lifecycle.target = svc;
  t = { svc, clock, woken };
  await svc.claim();
  agent = (await svc.addAgent("Assistant")).id;
  await svc.setRules([]);
  await svc.pairApprover(publicKeyOf(PHONE), "Phone");
});

/** A NIP-98 signed GET, as an approver app sends it. */
function signedGet(key: Uint8Array, url = INBOX, at = NOW) {
  const e = signEvent({ kind: 27235, created_at: at, tags: [["u", url], ["method", "GET"]], content: "" }, key);
  return `Nostr ${btoa(JSON.stringify(e))}`;
}

async function pending() {
  const r = await t.svc.submitRequest(agent, { act: "github.pr.merge", res: [PR], why: "reviewed and green" });
  const [item] = await t.svc.inbox(signedGet(PHONE), INBOX);
  return { r, item: item! };
}

function answer(item: PushedApproval, verdict: "allow" | "deny", key = PHONE) {
  return signEvent(answerTemplate({ v: 0, binding: item.binding, verdict }, NOW), key);
}

describe("approver apps: approvals pushed to another device", () => {
  it("puts a waiting request in the paired app's inbox and wakes it", async () => {
    const { r, item } = await pending();
    expect(t.woken.map((a) => a.name)).toEqual(["Phone"]);
    expect(item).toMatchObject({ card: r.cardId, act: "github.pr.merge", res: [PR], risk: "high" });
    expect(item.sentence).toMatch(/^Lets assistant merge PR #182/);
  });

  it("issues the grant when the app allows it, with its signed answer as the proof", async () => {
    const { r, item } = await pending();
    const e = answer(item, "allow");
    await t.svc.answer(e);
    await settle();
    const st = await t.svc.requestStatus(agent, r.request.id);
    expect(st?.status).toBe("granted");
    const g = openGrantEvent(st!.grant!);
    expect(g.ok && g.grant.assurance.method).toBe("approver");
    const proof = (g.ok ? g.grant.assurance.proof : null) as { approver: string; event: unknown };
    expect(proof.approver).toBe(publicKeyOf(PHONE));
    expect(verifyEvent(proof.event)).toBe(true);
    expect(await t.svc.inbox(signedGet(PHONE), INBOX)).toEqual([]);
  });

  it("denies when the app says no", async () => {
    const { r, item } = await pending();
    await t.svc.answer(answer(item, "deny"));
    await settle();
    expect((await t.svc.requestStatus(agent, r.request.id))?.status).toBe("denied");
  });

  it("refuses an answer from a key that isn't paired, or for a different binding", async () => {
    const { item } = await pending();
    await expect(t.svc.answer(answer(item, "allow", STRANGER))).rejects.toThrow(/isn't paired/);
    const forged = signEvent(answerTemplate({ v: 0, binding: { ...item.binding, nonce: "00".repeat(8) }, verdict: "allow" }, NOW), PHONE);
    await expect(t.svc.answer(forged)).rejects.toThrow(/something else/);
  });

  it("refuses a replay once the card is answered", async () => {
    const { item } = await pending();
    const e = answer(item, "allow");
    await t.svc.answer(e);
    await expect(t.svc.answer(e)).rejects.toThrow(/nothing is waiting/);
  });

  it("lets only the paired app read its inbox, with a fresh signature for that URL", async () => {
    await pending();
    await expect(t.svc.inbox(null, INBOX)).rejects.toThrow(/sign the request/);
    await expect(t.svc.inbox(signedGet(STRANGER), INBOX)).rejects.toThrow(/isn't paired/);
    await expect(t.svc.inbox(signedGet(PHONE, "https://evil.example/inbox"), INBOX)).rejects.toThrow(/another URL/);
    await expect(t.svc.inbox(signedGet(PHONE, INBOX, NOW - 600), INBOX)).rejects.toThrow(/too old/);
  });

  it("stops pushing once the app is unpaired", async () => {
    await t.svc.unpairApprover(publicKeyOf(PHONE));
    await t.svc.submitRequest(agent, { act: "github.pr.merge", res: [PR], why: "again" });
    expect(t.woken).toEqual([]);
    expect((await t.svc.snapshot()).approvers).toEqual([]);
  });
});
