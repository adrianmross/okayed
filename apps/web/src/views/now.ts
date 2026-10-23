import type { Card } from "@okayed/core";
import { cardView, h, type CardActions } from "@okayed/ui";
import type { App } from "../app.ts";

const SUGGESTIONS = [
  "I approve merging #182",
  "go ahead and deploy the website",
  "auto-approve read-only GitHub for 1 hour; ask me before anything that spends money",
  "never deploy to production",
];

let draft = "";

function actions(app: App): CardActions {
  const say = (text: string) => app.run("POST", "/chat", { text });
  return {
    confirm: (c: Card) => app.run("POST", `/cards/${c.id}/confirm`, undefined, c.kind === "policy" ? "Policy updated." : "Okayed. Issuing the grant…"),
    deny: (c: Card) => app.run("POST", `/cards/${c.id}/deny`, undefined, "Denied."),
    // A question's option re-asks with your own words plus the choice, so the engine binds both.
    pick: (c: Card, option: string) => say(`${c.utterance ?? ""} — ${option}`.trim()),
  };
}

/** Requests waiting for you on one side; the conversation with okayed on the other. */
export function nowView(app: App): HTMLElement {
  const { snap } = app;
  const act = actions(app);
  const waiting = snap.cards.filter((c) => c.status === "open" && c.source === "request");
  const issuing = snap.cards.filter((c) => c.status === "confirming").length;
  const cards = new Map(snap.cards.map((c) => [c.id, c]));

  const input = h("input", {
    class: "field",
    placeholder: "“I approve merging #182” or “ask me before anything that spends money”",
    value: draft,
    "aria-label": "Message",
    oninput: (e: Event) => (draft = (e.target as HTMLInputElement).value),
  }) as HTMLInputElement;
  const send = (text: string) => {
    if (!text.trim()) return;
    draft = "";
    app.run("POST", "/chat", { text });
  };
  const compose = h(
    "form",
    { class: "compose", onsubmit: (e: Event) => (e.preventDefault(), send(input.value)) },
    input,
    h("button", { class: "btn primary", type: "submit", disabled: app.busy }, app.busy ? "…" : "Send"),
  );

  // Newest turn first, each turn reading top-down: what you said, then okayed's card.
  const turns: HTMLElement[][] = [];
  for (const m of snap.chat) {
    if (m.role === "person") turns.push([h("div", { class: "bubble" }, m.text)]);
    else {
      const c = m.cardId ? cards.get(m.cardId) : undefined;
      (turns.at(-1) ?? (turns.push([]), turns.at(-1)!)).push(c ? cardView(c, act) : h("div", { class: "card" }, m.text));
    }
  }
  const conversation = turns.reverse().flat();

  return h(
    "div",
    { class: "cols" },
    h(
      "section",
      { class: "col", "aria-label": "Waiting for you" },
      h("h2", { class: "section-title" }, "Waiting for you"),
      issuing ? h("div", { class: "note" }, `${issuing} being issued…`) : null,
      waiting.length ? waiting.map((c) => cardView(c, act)) : h("div", { class: "card empty" }, "Nothing waiting. When an agent asks to do something, it shows up here."),
    ),
    h(
      "section",
      { class: "col chat", "aria-label": "Talk to okayed" },
      h("h2", { class: "section-title" }, "Talk to okayed"),
      compose,
      h("div", { class: "chips" }, SUGGESTIONS.map((s) => h("button", { class: "chip", type: "button", onclick: () => send(s) }, s))),
      conversation.length ? conversation : h("div", { class: "empty" }, "Approve something in your own words, or set a standing rule."),
    ),
  );
}
