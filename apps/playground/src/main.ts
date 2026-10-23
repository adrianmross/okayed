import "@okayed/ui/style.css";
import { brand, debugToggle, h } from "@okayed/ui";
import { narrowingSection } from "./narrowing.ts";
import { policySection } from "./policy.ts";

const WEB = (import.meta.env.VITE_WEB_URL as string | undefined) ?? "http://localhost:5173";
const REPO = "https://github.com/adrianmross/okayed";
const VIEWS = { policy: "Ask your policy", narrowing: "Words → grant" } as const;
type View = keyof typeof VIEWS;

let view: View = "policy";
const root = document.getElementById("app")!;

function render(): void {
  // Re-rendering replaces inputs; keep focus and caret on whichever one was being typed in.
  const active = document.activeElement as HTMLInputElement | null;
  const key = active?.dataset?.focus;
  const caret = active && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null;

  root.replaceChildren(
    h(
      "div",
      { class: "page" },
      h(
        "header",
        { class: "top" },
        brand("playground"),
        h("nav", { class: "seg", role: "tablist" }, (Object.keys(VIEWS) as View[]).map((k) => h("button", { role: "tab", type: "button", "aria-selected": String(view === k), onclick: () => ((view = k), render()) }, VIEWS[k]))),
        h("span", { class: "spacer" }),
        h("a", { class: "small", href: WEB, target: "_blank", rel: "noopener" }, "Web app"),
        h("a", { class: "small", href: REPO, target: "_blank", rel: "noopener" }, "GitHub"),
        debugToggle("okayed.playground.debug", render),
      ),
      h("p", { class: "muted", style: "margin:0" }, view === "policy" ? "Ask whether an agent may do something, and change the policy to see the answer move. Every verdict comes from the same engine the service runs, here in your browser." : "A model drafts a grant from what the person said; the engine cuts it to what the words and the pending request support, and lists every cut."),
      view === "policy" ? policySection(render) : narrowingSection(render),
    ),
  );

  const el = key ? (root.querySelector(`[data-focus="${key}"]`) as HTMLInputElement | null) : null;
  if (el) {
    el.focus();
    if (caret && typeof caret[0] === "number" && typeof caret[1] === "number") el.setSelectionRange(caret[0], caret[1]);
  }
}

render();
