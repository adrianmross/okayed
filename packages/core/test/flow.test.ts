import { beforeEach, describe, expect, it } from "vitest";
import { openGrantEvent, verifyEvent } from "@okayed/grant";
import {
  HeuristicDrafter,
  InlineLifecycle,
  KeySigner,
  ManualClock,
  MemoryStore,
  OkayedService,
  cryptoRandom,
  mergeWithGrant,
  settle,
  type Drafter,
} from "../src/index.ts";

const NOW = 1_761_735_600;
const SHA = "3f9a1c2e4b5d6f708192a3b4c5d6e7f801234567";
const PR = `github:adrianmross/okayed/pull/182@${SHA}`;

function setup(drafter: Drafter = new HeuristicDrafter()) {
  const clock = new ManualClock(NOW);
  const lifecycle = new InlineLifecycle(clock);
  const signer = KeySigner.forUser("22".repeat(32), "u1");
  const svc = new OkayedService({ userId: "u1", store: new MemoryStore(), clock, signer, drafter, lifecycle, random: cryptoRandom });
  lifecycle.target = svc;
  return { svc, clock, lifecycle, signer };
}

let t: ReturnType<typeof setup>;
let assistant: string;

beforeEach(async () => {
  t = setup();
  expect(await t.svc.claim()).toMatch(/^own_/);
  expect(await t.svc.claim()).toBeNull();
  const a = await t.svc.addAgent("Assistant");
  assistant = a.id;
  expect(await t.svc.agentFor(a.token)).toBe("agent:assistant");
  // These suites test the one-time flow, so start from a policy that asks about everything.
  await t.svc.setRules([]);
});

async function grantFor(requestId: string) {
  const st = await t.svc.requestStatus(assistant, requestId);
  expect(st?.status).toBe("granted");
  return st!.grant!;
}

describe("request → card → confirm → issue → verify", () => {
  it("issues a once-only merge grant; the second use is refused", async () => {
    const { request, status, cardId } = await t.svc.submitRequest(assistant, { act: "github.pr.merge", res: [PR], why: "reviewed and green" });
    expect(status).toBe("pending");
    const snap = await t.svc.snapshot();
    const card = snap.cards.find((c) => c.id === cardId)!;
    expect(card.sentence).toBe("Lets assistant merge PR #182 in adrianmross/okayed at 3f9a1c2, once, within the next 15 minutes.");
    expect(card.risk).toBe("high");

    await t.svc.confirm(cardId!);
    await settle();
    const ev = await grantFor(request.id);
    expect(verifyEvent(ev)).toBe(true);
    const opened = openGrantEvent(ev, [t.signer.pubkey]);
    expect(opened.ok && opened.grant.assurance.method).toBe("web-click");

    const use = { event: ev, aud: assistant, act: "github.pr.merge", res: PR, consume: true };
    const first = await t.svc.verify(use);
    expect(first).toMatchObject({ ok: true, left: 0 });
    expect(first.ok && verifyEvent(first.receipt)).toBe(true);
    expect(await t.svc.verify(use)).toMatchObject({ ok: false, code: "used_up" });
  });

  it("concurrent uses of a once grant: exactly one succeeds", async () => {
    const { request, cardId } = await t.svc.submitRequest(assistant, { act: "github.pr.merge", res: [PR] });
    await t.svc.confirm(cardId!);
    await settle();
    const ev = await grantFor(request.id);
    const use = { event: ev, aud: assistant, act: "github.pr.merge", res: PR, consume: true };
    const results = await Promise.all(Array.from({ length: 10 }, () => t.svc.verify(use)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("refuses a use by another agent, on another resource, or with a tampered event", async () => {
    const { request, cardId } = await t.svc.submitRequest(assistant, { act: "github.pr.merge", res: [PR] });
    await t.svc.confirm(cardId!);
    await settle();
    const ev = await grantFor(request.id);
    expect(await t.svc.verify({ event: ev, aud: "agent:mallory", act: "github.pr.merge", res: PR, consume: true })).toMatchObject({ code: "wrong_audience" });
    expect(await t.svc.verify({ event: ev, aud: assistant, act: "github.pr.merge", res: PR.replace("182", "183"), consume: true })).toMatchObject({ code: "wrong_resource" });
    expect(await t.svc.verify({ event: { ...ev, content: ev.content.replace('"uses":1', '"uses":9') }, aud: assistant, act: "github.pr.merge", res: PR, consume: true })).toMatchObject({ code: "bad_event" });
  });

  it("expires grants via the lifecycle and refuses late uses", async () => {
    const { request, cardId } = await t.svc.submitRequest(assistant, { act: "github.pr.merge", res: [PR] });
    await t.svc.confirm(cardId!);
    await settle();
    const ev = await grantFor(request.id);
    await t.clock.advance(15 * 60);
    expect(t.lifecycle.outcomes.get(cardId!)).toBe("expired");
    expect((await t.svc.snapshot()).grants[0]!.status).toBe("expired");
    expect(await t.svc.verify({ event: ev, aud: assistant, act: "github.pr.merge", res: PR, consume: true })).toMatchObject({ code: "expired" });
  });

  it("revokes at any time", async () => {
    const { request, cardId } = await t.svc.submitRequest(assistant, { act: "github.pr.merge", res: [PR] });
    await t.svc.confirm(cardId!);
    await settle();
    const ev = await grantFor(request.id);
    const opened = openGrantEvent(ev);
    await t.svc.revoke(opened.ok ? opened.grant.id : "");
    expect(t.lifecycle.outcomes.get(cardId!)).toBe("revoked");
    expect(await t.svc.verify({ event: ev, aud: assistant, act: "github.pr.merge", res: PR, consume: true })).toMatchObject({ code: "revoked" });
  });

  it("lapses an unanswered request", async () => {
    const { request, cardId } = await t.svc.submitRequest(assistant, { act: "github.pr.merge", res: [PR], ttl: 600 });
    await t.clock.advance(601);
    expect(t.lifecycle.outcomes.get(cardId!)).toBe("lapsed");
    expect((await t.svc.requestStatus(assistant, request.id))?.status).toBe("expired");
    await expect(t.svc.confirm(cardId!)).rejects.toThrow(/lapsed/);
  });

  it("denies", async () => {
    const { request, cardId } = await t.svc.submitRequest(assistant, { act: "github.pr.merge", res: [PR] });
    await t.svc.deny(cardId!);
    expect((await t.svc.requestStatus(assistant, request.id))?.status).toBe("denied");
  });

  it("rejects malformed requests", async () => {
    await expect(t.svc.submitRequest(assistant, { act: "github.*", res: [PR] })).rejects.toThrow(/unknown action/);
    await expect(t.svc.submitRequest(assistant, { act: "github.pr.merge", res: ["github:adrianmross/**"] })).rejects.toThrow(/not an exact resource/);
    await expect(t.svc.submitRequest(assistant, { act: "github.pr.merge", res: ["github:adrianmross/okayed/pull/182"] })).rejects.toThrow(/not an exact resource/);
  });
});

describe("chat", () => {
  it("'I approve merging #182' binds to the pending request and supersedes its card", async () => {
    const { request, cardId: reqCard } = await t.svc.submitRequest(assistant, { act: "github.pr.merge", res: [PR] });
    const card = await t.svc.chat("I approve merging #182");
    expect(card.kind).toBe("grant");
    expect(card.requestId).toBe(request.id);
    await t.svc.confirm(card.id);
    await settle();
    await grantFor(request.id);
    const snap = await t.svc.snapshot();
    expect(snap.cards.find((c) => c.id === reqCard)!.status).toBe("closed");
  });

  it("sets policy in plain words; read-only GitHub is then auto-approved for an hour", async () => {
    const card = await t.svc.chat("auto-approve read-only GitHub for 1 hour; ask me before anything that spends money");
    expect(card.kind).toBe("policy");
    expect(card.ruleTexts).toEqual(["Allow reading GitHub for 1 hour", "Ask before spending money"]);
    await t.svc.confirm(card.id);

    const r = await t.svc.submitRequest(assistant, { act: "github.read", res: ["github:adrianmross/okayed"] });
    expect(r.status).toBe("approving");
    await settle();
    const ev = await grantFor(r.request.id);
    const opened = openGrantEvent(ev);
    expect(opened.ok && opened.grant.assurance.method).toBe("policy");

    await t.clock.advance(3600);
    const later = await t.svc.submitRequest(assistant, { act: "github.read", res: ["github:adrianmross/okayed"] });
    expect(later.status).toBe("pending");
  });

  it("emergency stop revokes everything and pauses auto-approval", async () => {
    const card = await t.svc.chat("auto-approve read-only GitHub");
    await t.svc.confirm(card.id);
    const r = await t.svc.submitRequest(assistant, { act: "github.read", res: ["github:adrianmross/okayed"] });
    await settle();
    const ev = await grantFor(r.request.id);
    expect(await t.svc.stop()).toBe(1);
    expect(await t.svc.verify({ event: ev, aud: assistant, act: "github.read", res: "github:adrianmross/okayed", consume: true })).toMatchObject({ ok: false });
    const again = await t.svc.submitRequest(assistant, { act: "github.read", res: ["github:adrianmross/okayed"] });
    await settle();
    expect((await t.svc.requestStatus(assistant, again.request.id))?.status).not.toBe("granted");
    await t.svc.resume();
  });

  it("a hostile model can't widen what gets issued", async () => {
    const evil: Drafter = {
      name: "evil",
      async draft() {
        return { intent: "grant", grant: { act: "github.*", res: ["github:adrianmross/**"], ttl: 10 ** 8, uses: 10 ** 6, aud: "agent:mallory" } };
      },
      async explain() {
        return "Totally safe, approve!";
      },
    };
    t = setup(evil);
    await t.svc.claim();
    assistant = (await t.svc.addAgent("assistant")).id;
    await t.svc.setRules([]);
    const { request } = await t.svc.submitRequest(assistant, { act: "github.pr.merge", res: [PR] });
    const card = await t.svc.chat("I approve merging #182");
    expect(card.draft).toMatchObject({ act: "github.pr.merge", res: [PR], uses: 1, aud: assistant });
    expect(card.beyond.length).toBeGreaterThanOrEqual(4);
    expect(card.explanation).toBe("Totally safe, approve!");
    expect(card.sentence).not.toMatch(/safe/);
    await t.svc.confirm(card.id);
    await settle();
    const opened = openGrantEvent(await grantFor(request.id));
    expect(opened.ok && opened.grant.res).toEqual([PR]);
  });

  it("asks instead of guessing", async () => {
    await t.svc.setTargets({ sites: [{ host: "openmeadow.org", envs: ["production", "staging"] }, { host: "buzz.dev", envs: ["production"] }] });
    const card = await t.svc.chat("go ahead and deploy the website");
    expect(card).toMatchObject({ kind: "question", question: "Which site?" });
  });
});

describe("GitHub demo tool", () => {
  it("merges with the vault token only under a live grant, and only once", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.includes("/check-runs")) return Response.json({ check_runs: [{ status: "completed", conclusion: "success" }] });
      if (url.endsWith("/merge")) return Response.json({ sha: "merged123", merged: true });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const vault = { github: async () => "ghp_secret" };
    const { request, cardId } = await t.svc.submitRequest(assistant, { act: "github.pr.merge", res: [PR] });
    const input = { aud: assistant, owner: "adrianmross", repo: "okayed", number: 182, sha: SHA, grant: null as unknown };

    expect(await mergeWithGrant(t.svc, vault, input, fakeFetch)).toMatchObject({ ok: false, stage: "grant" });
    expect(calls.some((c) => c.url.endsWith("/merge"))).toBe(false);

    await t.svc.confirm(cardId!);
    await settle();
    input.grant = await grantFor(request.id);
    expect(await mergeWithGrant(t.svc, vault, input, fakeFetch)).toMatchObject({ ok: true, merged: true, left: 0 });
    const merge = calls.find((c) => c.url.endsWith("/merge"))!;
    expect(JSON.parse(String(merge.init!.body))).toMatchObject({ sha: SHA });
    expect(new Headers(merge.init!.headers).get("authorization")).toBe("Bearer ghp_secret");
    expect(await mergeWithGrant(t.svc, vault, input, fakeFetch)).toMatchObject({ ok: false, stage: "grant", reason: expect.stringMatching(/one use/) });
  });

  it("does not spend the use when a condition fails", async () => {
    const red = (async (url: string) =>
      url.includes("/check-runs") ? Response.json({ check_runs: [{ status: "completed", conclusion: "failure" }] }) : Response.json({ sha: "x" })) as typeof fetch;
    await t.svc.submitRequest(assistant, { act: "github.pr.merge", res: [PR] });
    const card = await t.svc.chat("merge #182 once CI passes");
    await t.svc.confirm(card.id);
    await settle();
    const snap = await t.svc.snapshot();
    const ev = snap.grants[0]!.event;
    const input = { aud: assistant, owner: "adrianmross", repo: "okayed", number: 182, sha: SHA, grant: ev };
    expect(await mergeWithGrant(t.svc, { github: async () => "t" }, input, red)).toMatchObject({ ok: false, reason: expect.stringMatching(/checks have not passed/) });
    expect((await t.svc.snapshot()).grants[0]!.used).toBe(0);
  });
});

describe("standing policies", () => {
  async function fresh() {
    t = setup();
    await t.svc.claim();
    assistant = (await t.svc.addAgent("assistant")).id;
  }
  const pr = (n: number) => `github:adrianmross/okayed/pull/${n}@${SHA}`;
  async function ask(n: number) {
    const r = await t.svc.submitRequest(assistant, { act: "github.pr.merge", res: [pr(n)] });
    await settle();
    return { r, st: await t.svc.requestStatus(assistant, r.request.id) };
  }

  it("the default posture merges when checks pass, with no budget, and names the policy", async () => {
    await fresh();
    const { r, st } = await ask(182);
    expect(r.status).toBe("approving");
    const opened = openGrantEvent(st!.grant!);
    expect(opened.ok && opened.grant).toMatchObject({ when: [{ c: "checks.pass" }], assurance: { method: "policy", policy: ["posture:merge"] } });
    for (let n = 1; n <= 8; n++) expect((await ask(n)).st!.status).toBe("granted");
    expect((await t.svc.snapshot()).usage["posture:merge"]).toEqual({ uses: 9, risk: 72 });
  });

  it("a policy's own budget asks once spent, says what spent it, and a top-up lets it continue", async () => {
    await fresh();
    await t.svc.setRules([{ id: "merges", effect: "allow", act: "github.pr.merge", budget: { uses: 5 } }]);
    for (let n = 1; n <= 5; n++) {
      expect((await ask(n)).st!.status).toBe("granted");
      await t.clock.advance(1);
    }
    const sixth = await ask(6);
    expect(sixth.r.status).toBe("pending");
    const card = (await t.svc.snapshot()).cards.find((c) => c.id === sixth.r.cardId)!;
    expect(card.topUp).toBe("merges");
    expect(card.notes.join()).toMatch(/limit is used up: 5 uses, 40 points, most recently PR #5 in adrianmross\/okayed; PR #4/);
    await t.svc.topUp("merges");
    expect((await ask(7)).st!.status).toBe("granted");
  });

  it("a shared budget spans policies, and can count your own okays too", async () => {
    await fresh();
    await t.svc.setBudgets([{ id: "today", risk: 16, counts: "all", note: "today" }]);
    expect((await ask(1)).st!.status).toBe("granted");
    // Approving one by hand also draws on a pool that counts everything.
    await t.svc.setRules([]);
    const manual = await ask(2);
    await t.svc.confirm(manual.r.cardId!);
    await settle();
    expect((await t.svc.snapshot()).usage["budget:today"]).toEqual({ uses: 2, risk: 16 });
    await t.svc.setRules([{ id: "m", effect: "allow", act: "github.pr.merge" }]);
    const third = await ask(3);
    expect(third.r.status).toBe("pending");
    const card = (await t.svc.snapshot()).cards.find((c) => c.id === third.r.cardId)!;
    expect(card.topUp).toBe("budget:today");
    expect(card.notes.join()).toMatch(/limit “today” is used up: 2 uses, 16 points/);
    await t.svc.topUp("budget:today");
    expect((await ask(4)).st!.status).toBe("granted");
  });

  it("budgets are checked before they're stored", async () => {
    await fresh();
    await expect(t.svc.setBudgets([{ id: "x" }])).rejects.toThrow(/uses, an amount of risk/);
    await expect(t.svc.topUp("budget:nope")).rejects.toThrow(/no budget/);
  });

  it("a standing policy said in words takes over for its scope", async () => {
    await fresh();
    const card = await t.svc.chat("let assistant merge anything in okayed when checks pass for 2 weeks up to 30 merges");
    expect(card.kind).toBe("policy");
    await t.svc.confirm(card.id);
    const { st } = await ask(200);
    const opened = openGrantEvent(st!.grant!);
    expect(opened.ok && opened.grant.assurance.policy?.[0]).toMatch(/^allow:github\.pr\.merge:/);
    await t.clock.advance(14 * 86400);
    // Past its horizon the posture applies again.
    const later = await ask(201);
    expect(openGrantEvent(later.st!.grant!).ok && openGrantEvent(later.st!.grant!)).toMatchObject({ grant: { assurance: { policy: ["posture:merge"] } } });
  });

  it("rules can be replaced directly, and bad ones are refused", async () => {
    await fresh();
    await expect(t.svc.setRules([{ id: "x", effect: "maybe", act: "github.read" }])).rejects.toThrow(/effect must be/);
    await t.svc.setRules([{ id: "deny-all", effect: "deny", act: "*" }]);
    expect((await ask(1)).st!.status).toBe("denied");
  });
});
