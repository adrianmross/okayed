import {
  allowsFor,
  DEFAULT_USER_LAYER,
  describeRule,
  doesNotAllowFor,
  narrowGrant,
  narrowPolicy,
  sentenceFor,
  summarize,
  type Decision,
  type GrantDraft,
  type NarrowResult,
  type Policy,
  type Request,
  type Targets,
} from "@okayed/engine";
import type { Grant } from "@okayed/grant";
import type { Draft } from "./ports.ts";
import type { Card } from "./records.ts";

/** Building cards: pure functions from engine results to what the person is shown. */

export function draftOf(g: Grant): GrantDraft {
  return { aud: g.aud, act: g.act, res: g.res, when: g.when, nbf: g.nbf, exp: g.exp, uses: g.uses, risk: g.risk, from: g.from };
}

export function decisionView(d: Pick<Decision, "verdict" | "reason" | "layers">): NonNullable<Card["decision"]> {
  return { verdict: d.verdict, reason: d.reason, layers: d.layers.map(({ layer, verdict, why }) => ({ layer, verdict, why })) };
}

export function grantCard(id: string, result: Extract<NarrowResult, { kind: "grant" }>, source: Card["source"], now: number): Card {
  const d = result.draft;
  return {
    id,
    kind: "grant",
    source,
    status: "open",
    createdAt: now,
    requestId: d.from.request,
    sentence: sentenceFor(d),
    allows: allowsFor(d),
    doesNot: doesNotAllowFor(d),
    risk: d.risk,
    beyond: result.beyond,
    notes: result.notes,
    summary: summarize(result),
    decision: decisionView(result.decision),
    draft: d,
    ttl: d.exp - d.nbf,
    asked: result.asked,
  };
}

/** A closed card that only says something: a reply, a question or a refusal. */
function sayingCard(id: string, kind: "reply" | "question" | "refuse", text: string, sentence: string, now: number, extra: Partial<Card> = {}): Card {
  return { id, kind, source: "chat", status: "closed", createdAt: now, utterance: text, sentence, allows: [], doesNot: [], beyond: [], notes: [], ...extra };
}

export interface ChatWorld {
  policy: Policy;
  targets: Targets;
  pending: Request[];
  now: number;
}

/** Turns the model's draft of what the person said into a card, with the engine deciding everything in it. */
export function chatCard(id: string, text: string, draft: Draft, w: ChatWorld): Card {
  const { now } = w;
  if (draft.intent === "other") return sayingCard(id, "reply", text, draft.reply.slice(0, 500), now);

  if (draft.intent === "policy") {
    const r = narrowPolicy({ utterance: text, proposal: draft.policy, policy: w.policy, layer: DEFAULT_USER_LAYER.name, targets: w.targets, now });
    if (r.kind === "question") return sayingCard(id, "question", text, r.question, now, { question: r.question, options: r.options, beyond: r.beyond });
    const texts = r.rules.map((x) => describeRule(x, now));
    return {
      id,
      kind: "policy",
      source: "chat",
      status: r.rules.length ? "open" : "closed",
      createdAt: now,
      utterance: text,
      sentence: r.rules.length ? `Change your policy: ${texts.join("; ")}.` : "Nothing in that changes your policy.",
      allows: r.rules.filter((x) => x.effect === "allow").map((x) => describeRule(x, now)),
      doesNot: [...r.rules.filter((x) => x.effect !== "allow").map((x) => describeRule(x, now)), "auto-approve anything that changes the world (okayed's own layer always asks)"],
      beyond: r.beyond,
      notes: r.notes,
      rules: r.rules,
      ruleTexts: texts,
      warnings: r.warnings.map((x) => `${x.layer}/${x.rule}: ${x.message}`),
    };
  }

  const result = narrowGrant({ utterance: text, proposal: draft.grant, requests: w.pending, targets: w.targets, policy: w.policy, now });
  if (result.kind === "grant") return { ...grantCard(id, result, "chat", now), utterance: text };
  if (result.kind === "question") return sayingCard(id, "question", text, result.question, now, { question: result.question, options: result.options, beyond: result.beyond });
  return sayingCard(id, "refuse", text, result.reason, now, { beyond: result.beyond, summary: summarize(result), ...(result.decision ? { decision: decisionView(result.decision) } : {}) });
}
