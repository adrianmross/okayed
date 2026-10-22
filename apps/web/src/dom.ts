type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; style?: string };

/** Tiny hyperscript: h("div", { class: "x", onclick }, children). */
export function h(tag: string, props: Props | null = null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "value" && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) el.value = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

export function toast(text: string): void {
  const t = h("div", { class: "toast", role: "status" }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

export function ago(unix: number, now = Date.now() / 1000): string {
  const d = Math.round(now - unix);
  if (d < 0) return `in ${left(-d)}`;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(unix * 1000).toLocaleDateString();
}

export function left(s: number): string {
  if (s <= 0) return "0 s";
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ""}`.trim();
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

export const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="currentColor" opacity=".14"/><path d="M9 16.5l4.5 4.5L23 11.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function logo(): HTMLElement {
  const s = h("span", { class: "brand", style: "color: var(--accent)" });
  s.innerHTML = LOGO;
  s.append(h("span", { style: "color: var(--ink)" }, "okayed"));
  return s;
}
