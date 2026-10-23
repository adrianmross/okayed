import { ago, block, h, type Tone } from "@okayed/ui";
import type { App } from "../app.ts";

const TONE: Record<string, Tone> = { grant: "allow", use: "allow", receipt: "allow", request: "who", policy: "what", agent: "who", revoke: "deny", stop: "deny", deny: "deny", expire: "time", lapse: "time" };

export function activityView(app: App): HTMLElement {
  const { snap } = app;
  if (!snap.audit.length) return h("div", { class: "card empty" }, "Nothing has happened yet.");
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "blocks" },
      snap.audit.map((a) =>
        h(
          "div",
          null,
          block(TONE[a.type] ?? "time", a.text, h("div", { class: "why" }, `${a.type} · ${ago(a.at, snap.now)}${a.event ? ` · Nostr kind ${a.event.kind}` : ""}`)),
          a.event ? h("div", { class: "debug-only" }, h("pre", null, JSON.stringify(a.event, null, 2))) : null,
        ),
      ),
    ),
  );
}
