import "./style.css";
import { AgentClient } from "agents/client";
import type { Card, Snapshot } from "@okayed/core";
import { cardView } from "./card.ts";
import { ago, h, left, logo, toast } from "./dom.ts";

const DEFAULT_API = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8787";
const PLAYGROUND = (import.meta.env.VITE_PLAYGROUND_URL as string | undefined) ?? "http://localhost:5174";
const STORE_KEY = "okayed.session.v0";

interface Session {
  api: string;
  userId: string;
  ownerToken: string;
}

function loadSession(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as Session | null;
    return s && s.userId && s.ownerToken ? s : null;
  } catch {
    return null;
  }
}

function saveSession(s: Session | null): void {
  try {
    if (s) localStorage.setItem(STORE_KEY, JSON.stringify(s));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // private mode: the session lasts as long as the tab
  }
}

let session = loadSession();
let snap: Snapshot | null = null;
let tab: "pending" | "grants" | "policy" | "audit" | "settings" = "pending";
let newAgentToken: { id: string; token: string } | null = null;
let client: AgentClient | null = null;
let busy = false;
const root = document.getElementById("app")!;

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  if (!session) throw new Error("no session");
  const r = await fetch(`${session.api}/api/u/${session.userId}${path}`, {
    method,
    headers: { authorization: `Bearer ${session.ownerToken}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
  return json;
}

async function refresh(): Promise<void> {
  try {
    snap = await api<Snapshot>("GET", "/state");
    render();
  } catch (e) {
    toast(String((e as Error).message));
  }
}

function connect(): void {
  if (!session) return;
  client?.close();
  const url = new URL(session.api);
  client = new AgentClient({
    agent: "okayed-agent",
    name: session.userId,
    host: url.host,
    protocol: url.protocol === "https:" ? "wss" : "ws",
    query: { token: session.ownerToken },
    onStateUpdate: (state: unknown) => {
      if (state) {
        snap = state as Snapshot;
        render();
      }
    },
  } as never);
}

async function act(fn: () => Promise<unknown>, ok?: string): Promise<void> {
  if (busy) return;
  busy = true;
  render();
  try {
    await fn();
    if (ok) toast(ok);
  } catch (e) {
    toast(String((e as Error).message));
  } finally {
    busy = false;
    await refresh();
  }
}

// ---------- welcome ----------

function welcome(): HTMLElement {
  const apiInput = h("input", { value: DEFAULT_API, "aria-label": "API base URL" }) as HTMLInputElement;
  const userInput = h("input", { placeholder: "user id" }) as HTMLInputElement;
  const tokenInput = h("input", { placeholder: "owner token (own_…)" }) as HTMLInputElement;
  const create = async () => {
    try {
      const base = apiInput.value.replace(/\/$/, "");
      const r = await fetch(`${base}/api/users`, { method: "POST" });
      const j = (await r.json()) as { userId: string; ownerToken: string; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      session = { api: base, userId: j.userId, ownerToken: j.ownerToken };
      saveSession(session);
      start();
    } catch (e) {
      toast(`Couldn't reach ${apiInput.value}: ${(e as Error).message}`);
    }
  };
  const join = () => {
    if (!userInput.value || !tokenInput.value) return toast("Paste both the user id and the owner token.");
    session = { api: apiInput.value.replace(/\/$/, ""), userId: userInput.value.trim(), ownerToken: tokenInput.value.trim() };
    saveSession(session);
    start();
  };
  return h(
    "div",
    { class: "welcome stack" },
    logo(),
    h("h1", null, "Your okay, made exact."),
    h(
      "p",
      { class: "lede" },
      "You tell your agent “I approve merging #182”. okayed turns that into the narrowest grant that says exactly that: one PR, one commit, one use, fifteen minutes. You see it before it exists, and you can take it back at any time.",
    ),
    h(
      "ol",
      { class: "steps" },
      h("li", null, "Your agent asks okayed before it acts (", h("code", null, "POST /requests"), ")."),
      h("li", null, "You say yes in plain words, or set a rule like “auto-approve read-only GitHub for 1 hour”."),
      h("li", null, "Llama 3.3 drafts the grant; a deterministic engine cuts it to what you said and shows what it cut."),
      h("li", null, "The tool verifies the signed grant before acting. “Once” means once."),
    ),
    h("div", { class: "row" }, h("button", { class: "primary", onclick: create }, "Create my okayed"), h("a", { href: "https://github.com/adrianmross/okayed", class: "small" }, "How it works")),
    h("details", null, h("summary", null, "Settings / use an existing account"), h("label", null, "API"), apiInput, h("label", null, "Existing account"), h("div", { class: "row" }, userInput, tokenInput, h("button", { onclick: join }, "Use"))),
  );
}

// ---------- chat ----------

const SUGGESTIONS = [
  "auto-approve read-only GitHub for 1 hour; ask me before anything that spends money",
  "I approve merging #182",
  "go ahead and deploy the website",
  "never deploy to production",
];

let draftText = "";

function chatPanel(s: Snapshot): HTMLElement {
  const cards = new Map(s.cards.map((c) => [c.id, c]));
  const messages = h("div", { class: "messages", "aria-live": "polite" });
  if (!s.chat.length) {
    messages.append(
      h(
        "div",
        { class: "empty" },
        "Tell okayed what your agents may do, in your own words. Approve a pending request, pre-approve one exact thing, or set a standing rule.",
      ),
    );
  }
  for (const m of s.chat) {
    if (m.role === "person") messages.append(h("div", { class: "msg person" }, m.text));
    else {
      const c = m.cardId ? cards.get(m.cardId) : undefined;
      messages.append(h("div", { class: "msg okayed" }, c ? cardView(c, cardActions) : h("div", { class: "card" }, m.text)));
    }
  }
  const input = h("input", {
    placeholder: "e.g. “I approve merging #182” or “ask me before anything that spends money”",
    value: draftText,
    oninput: (e: Event) => (draftText = (e.target as HTMLInputElement).value),
    "aria-label": "Message",
  }) as HTMLInputElement;
  const send = (text: string) => {
    if (!text.trim()) return;
    draftText = "";
    void act(() => api("POST", "/chat", { text }));
  };
  const form = h(
    "form",
    { onsubmit: (e: Event) => (e.preventDefault(), send(input.value)) },
    input,
    h("button", { class: "primary", type: "submit", disabled: busy }, busy ? "…" : "Send"),
  );
  const compose = h(
    "div",
    { class: "compose" },
    h("div", { class: "suggestions" }, SUGGESTIONS.map((x) => h("button", { class: "chip", type: "button", onclick: () => send(x) }, x))),
    form,
  );
  queueMicrotask(() => (messages.scrollTop = messages.scrollHeight));
  return h(
    "section",
    { class: "panel chat" },
    h("div", { class: "head" }, h("h2", null, "Chat"), h("span", { class: "spacer" }), h("span", { class: "muted small" }, `drafts by ${s.drafter}`)),
    messages,
    compose,
  );
}

const cardActions = {
  confirm: (c: Card) => act(() => api("POST", `/cards/${c.id}/confirm`), c.kind === "policy" ? "Policy updated." : "Confirmed. Issuing the grant…"),
  deny: (c: Card) => act(() => api("POST", `/cards/${c.id}/deny`), "Denied."),
  // A question's option re-asks with the person's own words plus the choice, so the engine binds both.
  pick: (c: Card, o: string) => void act(() => api("POST", "/chat", { text: `${c.utterance ?? ""} — ${o}`.trim() })),
};

// ---------- side panels ----------

function pendingTab(s: Snapshot): HTMLElement {
  const open = s.cards.filter((c) => c.status === "open" && c.source === "request");
  const confirming = s.cards.filter((c) => c.status === "confirming");
  return h(
    "div",
    null,
    confirming.length ? h("div", { class: "small muted", style: "margin-bottom:8px" }, `${confirming.length} being issued…`) : null,
    open.length ? open.map((c) => cardView(c, cardActions)) : h("div", { class: "empty" }, "No requests waiting. When an agent asks to do something, it shows up here."),
  );
}

function grantsTab(s: Snapshot): HTMLElement {
  if (!s.grants.length) return h("div", { class: "empty" }, "No grants yet.");
  return h(
    "div",
    null,
    s.grants.map((g) => {
      const live = g.status === "active";
      return h(
        "div",
        { class: "list-item" },
        h(
          "div",
          { class: "meta row" },
          h("span", { class: `badge ${g.status}` }, g.status),
          h("span", { class: `badge ${g.grant.risk}` }, g.grant.risk),
          h("span", { class: "small muted" }, `${g.used}/${g.grant.uses} used · ${live ? `expires in ${left(g.grant.exp - s.now)}` : ago(g.grant.exp, s.now)} · ${g.grant.assurance.method}`),
          h("span", { class: "spacer" }),
          live ? h("button", { class: "danger", onclick: () => act(() => api("POST", `/grants/${g.grant.id}/revoke`, { reason: "revoked by you" }), "Revoked.") }, "Revoke") : null,
        ),
        h("div", { style: "margin-top:6px" }, g.sentence),
        g.grant.from.utterance ? h("div", { class: "small muted" }, `From: “${g.grant.from.utterance}”`) : null,
        h("details", null, h("summary", null, "Signed event (kind 4841)"), h("pre", null, JSON.stringify(g.event, null, 2))),
      );
    }),
  );
}

function policyTab(s: Snapshot): HTMLElement {
  return h(
    "div",
    null,
    h("p", { class: "small muted" }, "Layers from top to bottom. A request is allowed only if every layer allows it; each layer can only narrow the one above. Change yours by saying it in the chat."),
    s.policy.described.map((l, i) =>
      h(
        "div",
        { class: "list-item" },
        h("div", { class: "row" }, h("strong", null, l.layer), h("span", { class: "muted small" }, i === 0 ? "built in — the most any policy can allow" : `default: ${s.policy.layers[i]?.default}`)),
        l.rules.length
          ? h(
              "table",
              { class: "layers" },
              l.rules.map((r) =>
                h(
                  "tr",
                  null,
                  h("td", null, h("span", { class: `badge ${r.effect}` }, r.effect)),
                  h("td", { colspan: "1", style: "width:auto" }, r.text, r.until && r.until <= s.now ? h("span", { class: "muted" }, " (expired)") : null),
                  i > 0 ? h("td", { style: "width:40px" }, h("button", { class: "ghost", title: "Remove rule", onclick: () => act(() => api("DELETE", `/rules/${encodeURIComponent(r.id)}`), "Rule removed.") }, "✕")) : h("td"),
                ),
              ),
            )
          : h("div", { class: "muted small" }, "No rules yet: everything asks you."),
      ),
    ),
    s.policy.warnings.length ? h("div", { class: "small", style: "color:var(--ask);margin-top:8px" }, s.policy.warnings.map((w) => h("div", null, w))) : null,
  );
}

function auditTab(s: Snapshot): HTMLElement {
  if (!s.audit.length) return h("div", { class: "empty" }, "Nothing has happened yet.");
  return h(
    "div",
    null,
    s.audit.map((a) =>
      h(
        "div",
        { class: "list-item small" },
        h("div", { class: "row" }, h("span", { class: `badge ${a.type === "grant" || a.type === "use" ? "allow" : a.type === "revoke" || a.type === "stop" || a.type === "deny" ? "deny" : "abstain"}` }, a.type), h("span", { class: "muted" }, ago(a.at, s.now))),
        h("div", { style: "margin-top:4px" }, a.text),
        a.event ? h("details", null, h("summary", null, `Nostr event kind ${a.event.kind}`), h("pre", null, JSON.stringify(a.event, null, 2))) : null,
      ),
    ),
  );
}

function settingsTab(s: Snapshot): HTMLElement {
  const agentName = h("input", { placeholder: "agent name, e.g. assistant" }) as HTMLInputElement;
  const repos = h("textarea", { rows: "3" }, s.targets.repos.join("\n")) as HTMLTextAreaElement;
  const sites = h("textarea", { rows: "3" }, s.targets.sites.map((x) => `${x.host}: ${x.envs.join(", ")}`).join("\n")) as HTMLTextAreaElement;
  const base = session!.api;
  const curl = newAgentToken
    ? `curl -X POST ${base}/api/u/${s.userId}/requests \\\n  -H 'authorization: Bearer ${newAgentToken.token}' \\\n  -H 'content-type: application/json' \\\n  -d '{"act":"github.pr.merge","res":["github:OWNER/REPO/pull/1@<40-hex head sha>"],"why":"tests pass"}'`
    : "";
  return h(
    "div",
    { class: "stack" },
    h("h3", null, "Agents"),
    s.agents.length
      ? s.agents.map((a) => h("div", { class: "row small" }, h("code", null, a.id), h("span", { class: "muted" }, ago(a.createdAt, s.now)), h("span", { class: "spacer" }), h("button", { class: "ghost", onclick: () => act(() => api("DELETE", `/agents/${encodeURIComponent(a.id)}`), "Agent removed.") }, "Remove")))
      : h("div", { class: "muted small" }, "No agents yet."),
    h(
      "form",
      {
        class: "row",
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (!agentName.value.trim()) return;
          void act(async () => {
            newAgentToken = await api<{ id: string; token: string }>("POST", "/agents", { name: agentName.value.trim() });
          });
        },
      },
      agentName,
      h("button", { type: "submit" }, "Add agent"),
    ),
    newAgentToken
      ? h("div", { class: "cut" }, h("div", { class: "small" }, `Token for ${newAgentToken.id}. It is shown once; okayed stores only its hash.`), h("pre", null, newAgentToken.token), h("div", { class: "small" }, "Try a request:"), h("pre", null, curl))
      : null,
    h("h3", null, "Known targets"),
    h("p", { class: "small muted" }, "Repos and sites okayed can bind your words to. Requests add to these automatically."),
    h("label", null, "Repositories (owner/repo, one per line)"),
    repos,
    h("label", null, "Sites (host: env, env)"),
    sites,
    h(
      "button",
      {
        onclick: () =>
          act(
            () =>
              api("PUT", "/targets", {
                repos: repos.value.split(/\s+/).filter(Boolean),
                sites: sites.value
                  .split("\n")
                  .map((l) => l.split(":"))
                  .filter((p) => p[0]?.trim())
                  .map(([host, envs]) => ({ host: host!.trim(), envs: (envs ?? "production").split(",").map((e) => e.trim()) })),
              }),
            "Saved.",
          ),
      },
      "Save targets",
    ),
    h("h3", null, "Emergency"),
    s.paused
      ? h("button", { onclick: () => act(() => api("POST", "/resume"), "Auto-approval resumed.") }, "Resume auto-approval")
      : h("button", { class: "danger", onclick: () => confirm("Revoke every live grant and pause auto-approval?") && act(() => api("POST", "/stop", { reason: "emergency stop" }), "Stopped.") }, "Emergency stop — revoke everything"),
    h("h3", null, "This account"),
    h(
      "dl",
      { class: "kv" },
      h("dt", null, "user"),
      h("dd", { class: "mono" }, s.userId),
      h("dt", null, "issuer key"),
      h("dd", { class: "mono" }, s.issuer),
      h("dt", null, "API"),
      h("dd", { class: "mono" }, base),
      h("dt", null, "verify"),
      h("dd", { class: "mono" }, `POST ${base}/api/u/${s.userId}/verify`),
    ),
    h("details", null, h("summary", null, "Owner token (keep it secret)"), h("pre", null, session!.ownerToken)),
    h("button", { class: "ghost", onclick: () => (confirm("Forget this account on this device?") ? (saveSession(null), (session = null), client?.close(), render()) : null) }, "Sign out on this device"),
  );
}

function side(s: Snapshot): HTMLElement {
  const pending = s.cards.filter((c) => c.status === "open" && c.source === "request").length;
  const active = s.grants.filter((g) => g.status === "active").length;
  const tabs: [typeof tab, string, number?][] = [
    ["pending", "Requests", pending],
    ["grants", "Grants", active],
    ["policy", "Policy"],
    ["audit", "Audit"],
    ["settings", "Settings"],
  ];
  const content = { pending: pendingTab, grants: grantsTab, policy: policyTab, audit: auditTab, settings: settingsTab }[tab](s);
  return h(
    "section",
    { class: "panel" },
    h("div", { class: "tabs", role: "tablist" }, tabs.map(([k, label, n]) => h("button", { class: tab === k ? "on" : "", role: "tab", "aria-selected": String(tab === k), onclick: () => ((tab = k), render()) }, label, n ? h("span", { class: "count" }, n) : null))),
    h("div", { class: "body" }, content),
  );
}

function render(): void {
  const focused = document.activeElement instanceof HTMLInputElement && document.activeElement.closest(".compose");
  root.replaceChildren();
  if (!session) {
    root.append(welcome());
    return;
  }
  const header = h("header", { class: "top" }, logo(), h("span", { class: "tagline" }, "scoped-authority approvals for AI agents"), h("span", { class: "spacer" }), h("a", { class: "small", href: PLAYGROUND, target: "_blank", rel: "noopener" }, "Policy playground ↗"));
  root.append(header);
  if (!snap) {
    root.append(h("div", { class: "empty" }, "Loading…"));
    return;
  }
  const main = h("main", { class: "layout" }, chatPanel(snap), h("div", null, snap.paused ? h("div", { class: "banner" }, "Auto-approval is paused after an emergency stop.", h("span", { class: "spacer" }), h("button", { onclick: () => act(() => api("POST", "/resume")) }, "Resume")) : null, side(snap)));
  root.append(main);
  if (focused) (root.querySelector(".compose input") as HTMLInputElement | null)?.focus();
}

function start(): void {
  render();
  void refresh();
  connect();
}

if (session) start();
else render();
setInterval(() => session && snap && render(), 15000);
