import type { Card } from "@okayed/core";
import { ago, h } from "./dom.ts";
import { block, cutBlocks, grantBlocks, layersTable, pill } from "./blocks.ts";

export interface CardActions {
  confirm?: (c: Card) => void;
  deny?: (c: Card) => void;
  pick?: (c: Card, option: string) => void;
}

const LABEL: Record<Card["kind"], string> = { grant: "Approval", policy: "Policy change", question: "Question", refuse: "Refused", reply: "okayed" };

/** One card: a short head, the facts as blocks, what was cut, then the decision buttons. */
export function cardView(c: Card, act: CardActions = {}): HTMLElement {
  const head = h(
    "div",
    { class: "card-head" },
    h("span", null, c.source === "request" ? `${(c.draft?.aud ?? "agent").replace(/^agent:/, "")} asks` : LABEL[c.kind]),
    c.risk ? h("span", { class: `badge ${c.risk}` }, `${c.risk} risk`) : null,
    c.kind === "grant" && c.status !== "open" ? h("span", { class: `badge ${c.status}` }, c.status) : null,
    h("span", { class: "spacer" }),
    h("span", null, ago(c.createdAt)),
  );
  const body: (HTMLElement | null)[] = [];
  if (c.draft) body.push(grantBlocks(c.draft));
  else if (c.kind === "policy" && c.rules) body.push(h("div", { class: "blocks" }, (c.ruleTexts ?? []).map((t, i) => block(c.rules![i]!.effect, t))));
  else body.push(h("div", { class: "line" }, c.sentence));
  if (c.options?.length) body.push(h("div", { class: "chips" }, c.options.map((o) => h("button", { class: "chip", type: "button", onclick: () => act.pick?.(c, o) }, o))));
  body.push(cutBlocks(c.beyond));
  if (c.notes.length) body.push(h("div", { class: "note" }, c.notes.join(" ")));
  if (c.warnings?.length) body.push(h("div", { class: "note" }, c.warnings.join(" ")));
  if (c.explanation) body.push(h("div", { class: "model" }, c.explanation));
  if (c.decision && c.kind === "grant") body.push(h("div", { class: "note" }, c.decision.reason));
  if (c.closedReason) body.push(h("div", { class: "note" }, `Closed: ${c.closedReason}`));
  if (c.status === "open" && (c.kind === "grant" || c.kind === "policy") && (act.confirm || act.deny)) {
    body.push(
      h(
        "div",
        { class: "actions" },
        act.confirm ? h("button", { class: "btn primary", type: "button", onclick: () => act.confirm!(c) }, c.kind === "policy" ? "Apply" : "Okay it") : null,
        act.deny ? h("button", { class: "btn", type: "button", onclick: () => act.deny!(c) }, "Deny") : null,
      ),
    );
  }
  body.push(
    h(
      "div",
      { class: "debug-only" },
      c.decision ? layersTable(c.decision) : null,
      c.draft ? h("pre", null, JSON.stringify(c.draft, null, 2)) : null,
      c.utterance ? h("div", { class: "note" }, "You said: ", pill(c.utterance)) : null,
    ),
  );
  return h("article", { class: "card" }, head, body);
}
