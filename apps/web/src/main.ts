import "@okayed/ui/style.css";
import { AgentClient } from "agents/client";
import type { Snapshot } from "@okayed/core";
import { brand, debugToggle, h, toast } from "@okayed/ui";
import type { App } from "./app.ts";
import { call, loadSession, saveSession, type Session } from "./session.ts";
import { activityView } from "./views/activity.ts";
import { grantsView } from "./views/grants.ts";
import { nowView } from "./views/now.ts";
import { policyView } from "./views/policy.ts";
import { setupView } from "./views/setup.ts";
import { welcome } from "./views/welcome.ts";

const DEFAULT_API = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8787";
const PLAYGROUND = (import.meta.env.VITE_PLAYGROUND_URL as string | undefined) ?? "http://localhost:5174";

const TABS = { now: "Now", grants: "Grants", policy: "Policy", activity: "Activity", setup: "Setup" } as const;
type Tab = keyof typeof TABS;

let session = loadSession();
let snap: Snapshot | null = null;
let tab: Tab = "now";
let busy = false;
let client: AgentClient | null = null;
const root = document.getElementById("app")!;

async function refresh(): Promise<void> {
  if (!session) return;
  try {
    snap = await call<Snapshot>(session, "GET", "/state");
  } catch (e) {
    toast((e as Error).message);
  }
  render();
}

/** Live state: the person's Durable Object pushes a snapshot after every change. */
function connect(s: Session): void {
  client?.close();
  const url = new URL(s.api);
  client = new AgentClient({
    agent: "okayed-agent",
    name: s.userId,
    host: url.host,
    protocol: url.protocol === "https:" ? "wss" : "ws",
    query: { token: s.ownerToken },
    onStateUpdate: (state: unknown) => {
      if (!state) return;
      snap = state as Snapshot;
      render();
    },
  } as never);
}

function start(s: Session): void {
  session = s;
  saveSession(s);
  render();
  void refresh();
  connect(s);
}

function signOut(): void {
  saveSession(null);
  session = null;
  snap = null;
  client?.close();
  render();
}

function app(s: Session, current: Snapshot): App {
  return {
    session: s,
    snap: current,
    busy,
    call: (method, path, body) => call(s, method, path, body),
    run: (method, path, body, ok) => {
      if (busy) return;
      busy = true;
      render();
      call(s, method, path, body)
        .then(() => ok && toast(ok), (e: Error) => toast(e.message))
        .finally(() => {
          busy = false;
          void refresh();
        });
    },
    rerender: render,
  };
}

function render(): void {
  const typing = document.activeElement instanceof HTMLInputElement && document.activeElement.closest(".compose");
  if (!session) {
    root.replaceChildren(welcome(DEFAULT_API, start));
    return;
  }
  const s = session;
  const waiting = snap?.cards.filter((c) => c.status === "open" && c.source === "request").length ?? 0;
  const header = h(
    "header",
    { class: "top" },
    brand(),
    h(
      "nav",
      { class: "seg", role: "tablist" },
      (Object.keys(TABS) as Tab[]).map((k) =>
        h("button", { role: "tab", type: "button", "aria-selected": String(tab === k), onclick: () => ((tab = k), render()) }, TABS[k], k === "now" && waiting ? ` · ${waiting}` : ""),
      ),
    ),
    h("span", { class: "spacer" }),
    h("a", { class: "small", href: PLAYGROUND, target: "_blank", rel: "noopener" }, "Playground"),
    debugToggle("okayed.debug", render),
  );
  let body: HTMLElement;
  if (!snap) body = h("div", { class: "empty" }, "Loading…");
  else {
    const a = app(s, snap);
    body = { now: nowView, grants: grantsView, policy: policyView, activity: activityView, setup: (x: App) => setupView(x, signOut) }[tab](a);
  }
  root.replaceChildren(
    h(
      "div",
      { class: "page" },
      header,
      snap?.paused ? h("div", { class: "problem" }, "Auto-approval is paused after an emergency stop. Resume it in Setup.") : null,
      body,
    ),
  );
  if (typing) (root.querySelector(".compose input") as HTMLInputElement | null)?.focus();
}

if (session) start(session);
else render();
// Countdowns and "expires in" stay current without a round trip.
setInterval(() => tab === "grants" && snap && session && ((snap = { ...snap, now: Math.floor(Date.now() / 1000) }), render()), 15000);
