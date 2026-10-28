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
    ...(snap.targets.named ? { named: snap.targets.named } : {}),
  };
}

export function useRules(): Rule[] {
  const { snap } = useOkayed();
  return snap?.policy.layers.find((l) => l.name === YOU)?.rules ?? [];
}

/**
 * "Always allow…" and "Block…" on an approval card. Without a duration they open the editor on the narrowest rule
 * that covers requests like this one; saving adds the rule and decides this request too, so one Face ID covers both.
 * With a duration (from hold-and-slide) the rule is added straight away, for that long or with no end (`null`).
 */
export function useRuleFromCard(): { alwaysAllow: (card: Card, forSeconds?: number | null) => void; block: (card: Card, forSeconds?: number | null) => void; editor: ReactNode } {
  const okayed = useOkayed();
  const world = useEditorWorld();
  const rules = useRules();
  const [open, setOpen] = useState<{ card: Card; effect: "allow" | "deny" } | null>(null);

  const ruleFor = (card: Card, effect: "allow" | "deny", forSeconds?: number | null): Rule => {
    const r = ruleFromRequest(card.draft!, `r-${card.id.slice(-6)}`);
    if (effect === "deny") {
      r.effect = "deny";
      delete r.when;
    }
    if (typeof forSeconds === "number" && world) r.until = world.now + forSeconds;
    return r;
  };
  const decide = (card: Card, effect: "allow" | "deny") => (effect === "allow" ? okayed.approve(card.id) : okayed.deny(card.id));
  const add = async (card: Card, rule: Rule, effect: "allow" | "deny") => {
    if ((await okayed.run("PUT", "/policy", { rules: [...rules, rule] }, effect === "allow" ? "Rule added: allowed from now on." : "Rule added: blocked from now on.")) === undefined) return false;
    return decide(card, effect);
  };
  const act = (effect: "allow" | "deny") => (card: Card, forSeconds?: number | null) => {
    if (!card.draft) return;
    if (forSeconds === undefined) setOpen({ card, effect });
    else void add(card, ruleFor(card, effect, forSeconds), effect);
  };

  const editor =
    open?.card.draft && world ? (
      <RuleEditor
        key={`${open.card.id}-${open.effect}`}
        rule={ruleFor(open.card, open.effect)}
        isNew
        rules={rules}
        world={world}
        title={open.effect === "allow" ? "Always allow" : "Block"}
        saveLabel={open.effect === "allow" ? "Add rule and allow" : "Add rule and don't allow"}
        onSave={async (next) => {
          if ((await okayed.run("PUT", "/policy", { rules: next }, "Rule added.")) === undefined) return false;
          return decide(open.card, open.effect);
        }}
        onClose={() => setOpen(null)}
      />
    ) : null;
  return { alwaysAllow: act("allow"), block: act("deny"), editor };
}
