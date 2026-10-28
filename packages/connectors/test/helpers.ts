import { HeuristicDrafter, InlineLifecycle, KeySigner, ManualClock, MemoryStore, OkayedService, cryptoRandom, settle } from "@okayed/core";

export const NOW = Math.floor(Date.now() / 1000);

/** A person's okayed with one agent, asking about everything, and a way to get a grant the person approved. */
export async function okayed() {
  const clock = new ManualClock(NOW);
  const lifecycle = new InlineLifecycle(clock);
  const svc = new OkayedService({ userId: "u1", store: new MemoryStore(), clock, signer: KeySigner.forUser("22".repeat(32), "u1"), drafter: new HeuristicDrafter(), lifecycle, random: cryptoRandom });
  lifecycle.target = svc;
  await svc.claim();
  const agent = (await svc.addAgent("Assistant")).id;
  await svc.setRules([]);
  const grant = async (act: string, res: string[], approve: (cardId: string) => Promise<unknown> = (id) => svc.confirm(id)) => {
    const { request, cardId } = await svc.submitRequest(agent, { act, res, why: "test" });
    await approve(cardId!);
    await settle();
    return (await svc.requestStatus(agent, request.id))!.grant!;
  };
  return { svc, agent, grant };
}
