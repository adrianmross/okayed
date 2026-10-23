type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown>;

/** Tiny hyperscript: h("div", { class: "x", onclick }, ...children). */
export function h(tag: string, props: Props | null = null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "value" && "value" in el) (el as HTMLInputElement).value = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  el.append(...flatten(children));
  return el;
}

function flatten(children: Child[]): (Node | string)[] {
  return children.flatMap((c) => (c === null || c === undefined || c === false ? [] : Array.isArray(c) ? flatten(c) : [c instanceof Node ? c : String(c)]));
}

export function toast(text: string): void {
  const t = h("div", { class: "toast", role: "status" }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

export function ago(unix: number, now = Date.now() / 1000): string {
  const d = Math.round(now - unix);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(unix * 1000).toLocaleDateString();
}

export function brand(subtitle?: string): HTMLElement {
  return h("div", { class: "brand" }, h("span", { class: "mark", "aria-hidden": "true" }, "✓"), "okayed", subtitle ? h("span", { class: "muted small", style: "font-weight:400" }, subtitle) : null);
}

/** Wraps localStorage so a blocked store never breaks the page. */
export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // storage blocked: the setting lasts as long as the tab
    }
  },
};

/** The Debug switch: hides JSON, layer tables and raw events unless on. */
export function debugToggle(key: string, onChange: () => void): HTMLElement {
  const on = store.get(key) === "1";
  document.documentElement.classList.toggle("debug", on);
  return h(
    "button",
    {
      type: "button",
      role: "switch",
      "aria-checked": String(on),
      class: "devtoggle",
      onclick: () => {
        store.set(key, on ? "0" : "1");
        onChange();
      },
    },
    h("span", { class: "knob", "aria-hidden": "true" }),
    "Debug",
  );
}
