import type { Card } from "@okayed/core";
import { RuleEditor, type EditorWorld } from "@okayed/design/okayed";
import { ruleFromRequest, YOU, type Rule } from "@okayed/engine";
import { useState, type ReactNode } from "react";
import { useOkayed } from "../lib/okayed";

/** The world the rule editor offers choices from: the person's agents, repos, sites, limits and usage. */
export function useEditorWorld(): EditorWorld | null {
  const { snap } = useOkayed();
  if (!snap) return null;
  return {
    agents: [...new Set(["agent:assistant", ...snap.agents.map((a) => a.id), ...snap.targets.agents])],
    repos: snap.targets.repos,
    sites: snap.targets.sites,
    budgets: snap.policy.budgets,
    usage: snap.usage,
    now: snap.now,
  };
}

export function useRules(): Rule[] {
  const { snap } = useOkayed();
  return snap?.policy.layers.find((l) => l.name === YOU)?.rules ?? [];
}

/**
 * "Always allow…" on an approval card: the narrowest rule that covers requests like this one, open in the editor.
 * Saving adds the rule and allows this request, so one Face ID covers both.
 */
export function useAlwaysAllow(): [(card: Card) => void, ReactNode] {
  const okayed = useOkayed();
  const world = useEditorWorld();
  const rules = useRules();
  const [card, setCard] = useState<Card | null>(null);
  const editor =
    card?.draft && world ? (
      <RuleEditor
        key={card.id}
        rule={ruleFromRequest(card.draft, `r-${card.id.slice(-6)}`)}
        isNew
        rules={rules}
        world={world}
        title="Always allow"
        saveLabel="Add rule and allow"
        onSave={async (next) => {
          if ((await okayed.run("PUT", "/policy", { rules: next }, "Rule added.")) === undefined) return false;
          return okayed.approve(card.id);
        }}
        onClose={() => setCard(null)}
      />
    ) : null;
  return [setCard, editor];
}
