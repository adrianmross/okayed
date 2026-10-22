import type { Card } from "@okayed/core";
import type { Beyond } from "@okayed/engine";
import { ago, h } from "./dom.ts";

/** Card rendering, shared by the web app and the playground. */

const FIELD: Record<Beyond["field"], string> = {
  request: "request",
  act: "action",
  res: "target",
  ttl: "lifetime",
  uses: "uses",
  when: "condition",
  aud: "agent",
  effect: "effect",
  until: "lasts",
};

export function beyondView(beyond: Beyond[]): HTMLElement | null {
  if (!beyond.length) return null;
  return h(
    "div",
    { class: "cut" },
    h("div", { class: "small", style: "font-weight:600;margin-bottom:4px" }, "Cut from the draft"),
    beyond.map((b) =>
      h(
        "div",
        { class: "line" },
        h("span", { class: "field" }, FIELD[b.field] ?? b.field),
        h("span", null, h("s", null, b.asked), b.granted ? [" → ", h("span", { class: "to" }, b.granted)] : " refused", h("span", { class: "muted" }, ` — ${b.why}`)),
      ),
    ),
  );
}

export function layersView(decision: NonNullable<Card["decision"]>): HTMLElement {
  return h(
    "details",
    null,
    h("summary", null, `Policy: ${decision.reason}`),
    h(
      "table",
      { class: "layers" },
      decision.layers.map((l) => h("tr", null, h("td", null, l.layer), h("td", null, h("span", { class: `badge ${l.verdict}` }, l.verdict)), h("td", { class: "muted" }, l.why))),
    ),
  );
}

export interface CardActions {
  confirm?: (c: Card) => void;
  deny?: (c: Card) => void;
  pick?: (c: Card, option: string) => void;
}

export function cardView(c: Card, act: CardActions = {}): HTMLElement {
  const open = c.status === "open";
  const kindLabel = c.kind === "grant" ? (c.source === "request" ? "request" : "approval") : c.kind;
  const head = h(
    "div",
    { class: "meta" },
    h("span", { class: `badge ${c.kind}` }, kindLabel),
    c.risk ? h("span", { class: `badge ${c.risk}` }, `${c.risk} risk`) : null,
    c.status !== "closed" || c.kind === "grant" ? h("span", { class: `badge ${c.status}` }, c.status) : null,
    c.decision && c.kind === "grant" && c.decision.verdict === "allow" ? h("span", { class: "badge allow" }, "policy would auto-approve") : null,
    h("span", { class: "spacer" }),
    h("span", { class: "muted small" }, ago(c.createdAt)),
  );
  const body: (HTMLElement | null)[] = [];
  if (c.utterance && c.source === "chat" && c.kind !== "reply") body.push(h("div", { class: "muted small" }, `You said: “${c.utterance}”`));
  body.push(h("div", { class: "sentence" }, c.sentence));
  if (c.kind === "grant" || c.kind === "policy") {
    body.push(
      h(
        "div",
        { class: "lists" },
        h("div", null, h("h3", null, c.kind === "policy" ? "Will auto-approve" : "Allows"), c.allows.length ? h("ul", { class: "ticks" }, c.allows.map((x) => h("li", null, x))) : h("div", { class: "muted small" }, "nothing new")),
        h("div", null, h("h3", null, c.kind === "policy" ? "Still asks or refuses" : "Does not allow"), h("ul", { class: "crosses" }, c.doesNot.map((x) => h("li", null, x)))),
      ),
    );
  }
  if (c.options?.length) {
    body.push(h("div", { class: "row", style: "margin-top:8px" }, c.options.map((o) => h("button", { class: "chip", onclick: () => act.pick?.(c, o) }, o))));
  }
  body.push(beyondView(c.beyond));
  if (c.notes.length) body.push(h("div", { class: "small muted", style: "margin-top:8px" }, c.notes.join(" ")));
  if (c.warnings?.length) body.push(h("div", { class: "small", style: "margin-top:8px;color:var(--ask)" }, c.warnings.join(" ")));
  if (c.explanation) body.push(h("div", { class: "explain" }, h("span", { class: "small" }, "In plain words (model): "), c.explanation));
  if (c.decision && c.kind !== "policy") body.push(layersView(c.decision));
  if (c.draft) body.push(h("details", null, h("summary", null, "Grant draft (JSON)"), h("pre", null, JSON.stringify(c.draft, null, 2))));
  if (c.closedReason) body.push(h("div", { class: "small muted" }, `Closed: ${c.closedReason}`));
  if (open && (c.kind === "grant" || c.kind === "policy") && (act.confirm || act.deny)) {
    body.push(
      h(
        "div",
        { class: "actions" },
        act.confirm ? h("button", { class: "primary", onclick: () => act.confirm!(c) }, c.kind === "policy" ? "Apply policy" : "Confirm — okay this") : null,
        act.deny ? h("button", { onclick: () => act.deny!(c) }, "Deny") : null,
      ),
    );
  }
  return h("div", { class: `card ${c.risk ? `risk-${c.risk}` : ""}` }, head, body);
}
