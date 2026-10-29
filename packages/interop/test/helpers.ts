import { HeuristicDrafter, InlineLifecycle, KeySigner, ManualClock, MemoryStore, OkayedService, cryptoRandom } from "@okayed/core";

export const NOW = 1_761_735_600;
export const SHA = "3f9a1c2e4b5d6f708192a3b4c5d6e7f801234567";

/** One person's okayed in memory, with an agent. */
export async function person(userId = "u1") {
  const clock = new ManualClock(NOW);
  const lifecycle = new InlineLifecycle(clock);
  const svc = new OkayedService({ userId, store: new MemoryStore(), clock, signer: KeySigner.forUser("22".repeat(32), userId), drafter: new HeuristicDrafter(), lifecycle, random: cryptoRandom });
  lifecycle.target = svc;
  const owner = (await svc.claim())!;
  await svc.setRules([]);
  const { id: agent, token } = await svc.addAgent("CI");
  return { svc, owner, agent, token, clock };
}
