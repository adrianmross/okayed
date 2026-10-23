import { grantBlocks, h } from "@okayed/ui";
import { humanDuration } from "@okayed/engine";
import type { App } from "../app.ts";

export function grantsView(app: App): HTMLElement {
  const { snap } = app;
  if (!snap.grants.length) return h("div", { class: "card empty" }, "No grants yet.");
  return h(
    "div",
    { class: "col" },
    snap.grants.map(({ grant: g, event, status, used }) => {
      const live = status === "active";
      return h(
        "article",
        { class: "card" },
        h(
          "div",
          { class: "card-head" },
          h("span", { class: `badge ${status}` }, status),
          h("span", null, `${used} of ${g.uses} used`),
          live ? h("span", null, `expires in ${humanDuration(Math.max(0, g.exp - snap.now))}`) : null,
          h("span", { class: "spacer" }),
          live ? h("button", { class: "btn", type: "button", onclick: () => app.run("POST", `/grants/${g.id}/revoke`, { reason: "revoked by you" }, "Revoked.") }, "Revoke") : null,
        ),
        grantBlocks({ ...g, from: g.from }),
        h("div", { class: "note" }, g.from.utterance ? `Because you said “${g.from.utterance}”` : "Auto-approved by your policy"),
        h("div", { class: "debug-only" }, h("pre", null, JSON.stringify(event, null, 2))),
      );
    }),
  );
}
