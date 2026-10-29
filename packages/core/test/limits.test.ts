import { describe, expect, it } from "vitest";
import { HeuristicDrafter, InlineLifecycle, KeySigner, ManualClock, MemoryStore, OkayedService, cryptoRandom, handleApi, settle } from "../src/index.ts";

const NOW = 1_761_735_600;

async function okayed() {
  const clock = new ManualClock(NOW);
  const lifecycle = new InlineLifecycle(clock);
  const svc = new OkayedService({ userId: "u1", store: new MemoryStore(), clock, signer: KeySigner.forUser("22".repeat(32), "u1"), drafter: new HeuristicDrafter(), lifecycle, random: cryptoRandom });
  lifecycle.target = svc;
  const owner = (await svc.claim())!;
  const ci = (await svc.addAgent("CI")).id;
  return { svc, owner, ci };
}

describe("limits from outside the person", () => {
  const org = { name: "your organization", default: "deny" as const, rules: [{ id: "org-1", effect: "allow" as const, act: "github.*" }] };

  it("block what the organization doesn't allow, even when the person's rules would", async () => {
    const { svc, ci } = await okayed();
    await svc.setCeiling("organization", org);
    const deploy = await svc.submitRequest(ci, { act: "site.deploy", res: ["site:openmeadow.org/preview"], why: "preview" });
    expect(deploy).toMatchObject({ status: "denied", reason: "Refused by your organization: nothing here covers site.deploy." });
    const read = await svc.submitRequest(ci, { act: "github.read", res: ["github:adrianmross/okayed"], why: "notes" });
    expect(read.status).toBe("approving");
    await settle();
    expect((await svc.requestStatus(ci, read.request.id))?.status).toBe("granted");
  });

  it("show in the snapshot and the activity, change quietly when nothing changed, and can be removed", async () => {
    const { svc } = await okayed();
    await svc.setCeiling("organization", org);
    await svc.setCeiling("organization", org);
    let snap = await svc.snapshot();
    expect(snap.policy.described.map((l) => l.layer)).toEqual(["your organization", "you"]);
    expect(snap.audit.filter((a) => a.text.startsWith("Limits from"))).toHaveLength(1);
    await svc.setCeiling("organization", null);
    snap = await svc.snapshot();
    expect(snap.policy.described.map((l) => l.layer)).toEqual(["you"]);
    expect(snap.audit[0]!.text).toBe("Limits from your organization were removed.");
  });

  it("refuse a malformed layer", async () => {
    const { svc } = await okayed();
    await expect(svc.setCeiling("organization", { name: "", default: "maybe" as never, rules: [{ id: "x" } as never] })).rejects.toThrow(/needs a name; default must be/);
    await expect(svc.setCeiling("Org Limits!", org)).rejects.toThrow(/short lowercase name/);
  });

  it("can't be set or lifted through the person's own API", async () => {
    const { svc, owner } = await okayed();
    await svc.setCeiling("organization", org);
    const call = (method: string, path: string, body?: unknown) =>
      handleApi(svc, new Request(`http://x${path}`, { method, headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), path);
    expect((await call("PUT", "/ceilings/organization", { rules: [] })).status).toBe(404);
    expect((await call("PUT", "/policy", { rules: [{ id: "all", effect: "allow", act: "*" }] })).status).toBe(200);
    expect((await svc.snapshot()).policy.layers[0]).toMatchObject({ name: "your organization", default: "deny" });
  });
});

describe("agent groups", () => {
  it("let one rule cover every agent in a group", async () => {
    const { svc, ci, owner } = await okayed();
    await svc.setRules([{ id: "deployers", effect: "allow", act: "site.deploy", res: "site:*/staging", agent: "group:deployers" }]);
    const ask = () => svc.submitRequest(ci, { act: "site.deploy", res: ["site:openmeadow.org/staging"], why: "x" });
    expect((await ask()).status).toBe("pending");
    const put = await handleApi(svc, new Request(`http://x/agents/${encodeURIComponent(ci)}/groups`, { method: "PUT", headers: { authorization: `Bearer ${owner}` }, body: JSON.stringify({ groups: ["deployers"] }) }), `/agents/${encodeURIComponent(ci)}/groups`);
    expect(put.status).toBe(200);
    expect((await ask()).status).toBe("approving");
    expect((await svc.snapshot()).agents.find((a) => a.id === ci)?.groups).toEqual(["deployers"]);
    await expect(svc.setAgentGroups(ci, ["Has Spaces"])).rejects.toThrow(/lowercase names/);
    await svc.setAgentGroups(ci, []);
    expect((await svc.snapshot()).agents.find((a) => a.id === ci)?.groups).toBeUndefined();
  });
});
