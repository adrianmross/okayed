import { describeRule, lint, sentenceFor, type Layer, type Policy, type Targets, type Usage } from "@okayed/engine";
import { draftOf } from "./cards.ts";
import type { Store } from "./ports.ts";
import type { AgentRecord, AuditEntry, Card, ChatMessage, GrantRecord, Meta, RequestRecord, Snapshot } from "./records.ts";

const SHOWN = 60;

async function all<T>(store: Pick<Store, "list">, prefix: string): Promise<T[]> {
  return [...(await store.list<T>(prefix)).values()];
}

/** What the person's browser sees: newest first, with lapsed items shown as expired even before the Workflow catches up. */
export async function buildSnapshot(
  store: Pick<Store, "get" | "list">,
  who: { userId: string; issuer: string; drafter: string },
  meta: Meta,
  policy: Policy,
  targets: Targets,
  usage: Usage,
  now: number,
): Promise<Omit<Snapshot, "passkeys" | "approvers" | "packs">> {
  const expiredIf = <T extends { status: string }>(r: T, lapsed: boolean): T => (lapsed ? { ...r, status: "expired" } : r);
  const cards = (await all<Card>(store, "card:")).sort((a, b) => b.createdAt - a.createdAt).slice(0, SHOWN);
  const requests = (await all<RequestRecord>(store, "req:"))
    .map((r) => expiredIf(r, r.status === "pending" && r.request.exp <= now))
    .sort((a, b) => b.request.at - a.request.at)
    .slice(0, SHOWN);
  const grants = (await all<GrantRecord>(store, "grant:"))
    .map((g) => ({ ...expiredIf(g, g.status === "active" && g.grant.exp <= now), sentence: sentenceFor(draftOf(g.grant)) }))
    .sort((a, b) => b.grant.nbf - a.grant.nbf)
    .slice(0, SHOWN);
  const agents = (await all<AgentRecord>(store, "agent:")).map(({ id, name, createdAt, workload }) => ({ id, name, createdAt, ...(workload ? { workload } : {}) }));
  const describe = (l: Layer) => ({
    layer: l.name,
    rules: l.rules.map((r) => ({ id: r.id, text: describeRule(r, now, usage), effect: r.effect, ...(r.until !== undefined ? { until: r.until } : {}) })),
  });
  return {
    ...who,
    now,
    paused: meta.paused,
    ...(meta.stoppedAt !== undefined ? { stoppedAt: meta.stoppedAt } : {}),
    policy: { layers: policy.layers, budgets: policy.budgets ?? [], described: policy.layers.map(describe), warnings: lint(policy, now).map((w) => `${w.layer}/${w.rule}: ${w.message}`) },
    cards,
    requests,
    grants,
    audit: ((await store.get<AuditEntry[]>("audit")) ?? []).slice(-150).reverse(),
    chat: (await store.get<ChatMessage[]>("chat")) ?? [],
    agents,
    targets,
    usage,
  };
}
