import { CATALOG, EXAMPLE_PACKS, unregisterPack } from "@okayed/engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HeuristicDrafter, InlineLifecycle, KeySigner, ManualClock, MemoryStore, OkayedService, adoptPacks, cryptoRandom, draftUser, enablePacks, settle } from "../src/index.ts";

const NOW = 1_761_735_600;

describe("capability packs, end to end", () => {
  beforeAll(() => enablePacks({ ids: "slack,email" }));
  afterAll(() => ["slack", "email"].forEach(unregisterPack));

  async function okayed() {
    const clock = new ManualClock(NOW);
    const lifecycle = new InlineLifecycle(clock);
    const svc = new OkayedService({ userId: "u1", store: new MemoryStore(), clock, signer: KeySigner.forUser("22".repeat(32), "u1"), drafter: new HeuristicDrafter(), lifecycle, random: cryptoRandom });
    lifecycle.target = svc;
    await svc.claim();
    await svc.setRules([]);
    const agent = (await svc.addAgent("Assistant")).id;
    return { svc, agent, clock };
  }

  it("a deployment picks packs by name, idempotently, and refuses unknown ones", () => {
    expect(CATALOG["slack.message.post"]?.verb).toBe("post to");
    expect(() => enablePacks({ ids: "slack" })).not.toThrow();
    expect(() => enablePacks({ ids: "fax" })).toThrow(/no capability pack called fax/);
  });

  it("an agent asks to post to Slack, the person okays it in words, and the grant pins the channel", async () => {
    const { svc, agent } = await okayed();
    const { request, status } = await svc.submitRequest(agent, { act: "slack.message.post", res: ["slack:acme/releases"], why: "release notes for 1.4" });
    expect(status).toBe("pending");
    const card = await svc.chat("yes, post it");
    expect(card).toMatchObject({ kind: "grant", draft: { act: "slack.message.post", res: ["slack:acme/releases"], uses: 1 } });
    await svc.confirm(card.id);
    await settle();
    const st = await svc.requestStatus(agent, request.id);
    expect(st?.status).toBe("granted");
    expect((await svc.verify({ event: st!.grant, aud: agent, act: "slack.message.post", res: "slack:acme/releases", consume: true })).ok).toBe(true);
    expect((await svc.verify({ event: st!.grant, aud: agent, act: "slack.message.post", res: "slack:acme/general", consume: true })).ok).toBe(false);
  });

  it("learns the channel's names from requests, so a rule in words binds to it", async () => {
    const { svc, agent } = await okayed();
    await svc.submitRequest(agent, { act: "slack.message.post", res: ["slack:acme/releases"], why: "x" });
    const snap = await svc.snapshot();
    expect(snap.targets.named).toEqual([{ res: "slack:acme/releases", names: ["releases", "#releases", "#releases in acme"] }]);
    const card = await svc.chat("always allow posting to #releases for a week");
    expect(card).toMatchObject({ kind: "policy", rules: [{ effect: "allow", act: "slack.message.post", res: "slack:acme/releases", until: NOW + 7 * 86400 }] });
  });

  it("tells the model the formats and the known targets, and the browser the packs", async () => {
    const { svc, agent } = await okayed();
    await svc.submitRequest(agent, { act: "slack.message.post", res: ["slack:acme/releases"], why: "x" });
    const snap = await svc.snapshot();
    expect(snap.packs.map((p) => p.id)).toEqual(["slack", "email"]);
    const prompt = draftUser("post it", { now: NOW, targets: snap.targets, pending: [], actions: Object.keys(CATALOG) });
    expect(prompt).toMatch(/slack\.channel slack:\{workspace\}\/\{channel\}/);
    expect(prompt).toMatch(/releases = slack:acme\/releases/);
    // A browser that gets the snapshot can read the same resources.
    expect(() => adoptPacks(snap.packs)).not.toThrow();
    expect(JSON.parse(JSON.stringify(EXAMPLE_PACKS.slack)).id).toBe("slack");
  });
});
