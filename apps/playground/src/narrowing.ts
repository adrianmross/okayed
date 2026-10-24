import { allowsFor, doesNotAllowFor, humanDuration, narrowGrant, sentenceFor, summarize, type NarrowResult, personalLayer } from "@okayed/engine";
import type { Card } from "@okayed/core";
import { cardView, h, toast } from "@okayed/ui";
import { DRAFTS, NOW, REQUESTS, SAYINGS, TARGETS } from "./data.ts";

const state = { said: SAYINGS[1]!, request: Object.keys(REQUESTS)[0]!, draftName: "prompt-injected", draft: JSON.stringify(DRAFTS["prompt-injected"], null, 2) };

function toCard(r: NarrowResult): Card {
  const base = { id: "demo", source: "chat" as const, createdAt: NOW, utterance: state.said, beyond: r.beyond, allows: [] as string[], doesNot: [] as string[], notes: [] as string[] };
  if (r.kind === "question") return { ...base, kind: "question", status: "closed", sentence: r.question, options: r.options };
  if (r.kind === "refuse") return { ...base, kind: "refuse", status: "closed", sentence: r.reason };
  return {
    ...base,
    kind: "grant",
    status: "open",
    requestId: r.draft.from.request,
    sentence: sentenceFor(r.draft),
    allows: allowsFor(r.draft),
    doesNot: doesNotAllowFor(r.draft),
    risk: r.draft.risk,
    notes: r.notes,
    decision: { verdict: r.decision.verdict, reason: r.decision.reason, layers: r.decision.layers.map(({ layer, verdict, why }) => ({ layer, verdict, why })) },
    draft: r.draft,
  };
}

/** Model draft beside engine grant, field by field; struck values didn't survive. */
function diff(r: NarrowResult): HTMLElement | null {
  if (r.kind !== "grant") return null;
  const a = r.asked;
  const d = r.draft;
  const rows: [string, string[], string[]][] = [
    ["action", a.act ? [a.act] : [], [d.act]],
    ["targets", a.res ?? [], d.res],
    ["lifetime", a.ttl !== undefined ? [humanDuration(a.ttl)] : [], [humanDuration(d.exp - d.nbf)]],
    ["uses", a.uses !== undefined ? [String(a.uses)] : [], [String(d.uses)]],
    ["agent", a.aud ? [a.aud] : [], [d.aud]],
    ["conditions", a.when?.map((c) => c.c) ?? [], d.when.map((c) => c.c)],
  ];
  return h(
    "table",
    { class: "diff" },
    h("tr", null, h("th", null, ""), h("th", null, "Model drafted"), h("th", null, "Engine granted")),
    rows.map(([k, asked, granted]) =>
      h(
        "tr",
        null,
        h("td", null, k),
        h("td", null, asked.length ? asked.map((x, i) => [i ? h("br") : null, granted.includes(x) ? x : h("s", null, x)]) : "—"),
        h("td", { class: asked.length && asked.join() !== granted.join() ? "kept" : "" }, granted.length ? granted.map((x, i) => [i ? h("br") : null, x]) : "none"),
      ),
    ),
  );
}

export function narrowingSection(rerender: () => void): HTMLElement {
  let draft: unknown = state.draft;
  try {
    draft = JSON.parse(state.draft);
  } catch {
    // Malformed model output is just an empty draft to the engine.
  }
  const req = REQUESTS[state.request];
  const result = narrowGrant({ utterance: state.said, proposal: draft, requests: req ? [req] : [], targets: TARGETS, policy: { layers: [personalLayer([])] }, now: NOW });
  const said = h("input", { class: "field", value: state.said, "data-focus": "said", "aria-label": "What the person says", oninput: (e: Event) => ((state.said = (e.target as HTMLInputElement).value), rerender()) });
  const draftBox = h("textarea", { class: "field", rows: "8", spellcheck: "false", "data-focus": "draft", "aria-label": "Model draft", oninput: (e: Event) => ((state.draft = (e.target as HTMLTextAreaElement).value), (state.draftName = ""), rerender()) }, state.draft);

  return h(
    "div",
    { class: "cols" },
    h(
      "div",
      { class: "col" },
      h("h2", { class: "section-title" }, "The person says"),
      said,
      h("div", { class: "chips" }, SAYINGS.map((s) => h("button", { class: "chip", type: "button", "aria-pressed": String(s === state.said), onclick: () => ((state.said = s), rerender()) }, s.length > 44 ? `${s.slice(0, 42)}…` : s))),
      h("h2", { class: "section-title" }, "What's pending"),
      h("div", { class: "chips" }, Object.keys(REQUESTS).map((k) => h("button", { class: "chip", type: "button", "aria-pressed": String(k === state.request), onclick: () => ((state.request = k), rerender()) }, k))),
      h("h2", { class: "section-title" }, "The model drafts (untrusted)"),
      h("div", { class: "chips" }, Object.keys(DRAFTS).map((k) => h("button", { class: "chip", type: "button", "aria-pressed": String(k === state.draftName), onclick: () => ((state.draftName = k), (state.draft = typeof DRAFTS[k] === "string" ? (DRAFTS[k] as string) : JSON.stringify(DRAFTS[k], null, 2)), rerender()) }, k))),
      draftBox,
    ),
    h(
      "div",
      { class: "col" },
      h("h2", { class: "section-title" }, "What the person sees"),
      cardView(toCard(result), { confirm: () => toast("In the web app this signs the grant."), deny: () => toast("Denied.") }),
      h("section", { class: "card" }, diff(result) ?? h("div", { class: "note" }, "No grant, so nothing to compare."), h("div", { class: "note debug-only" }, summarize(result))),
    ),
  );
}
