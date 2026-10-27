export interface Session {
  api: string;
  userId: string;
  /** Empty when Cloudflare Access vouches for the person instead. */
  ownerToken: string;
  access?: boolean;
}

/** The Worker serves this app, so the API is on the same origin; in development it's wrangler's port. */
export const DEFAULT_API = (import.meta.env.VITE_API_BASE as string | undefined) ?? (import.meta.env.DEV ? "http://localhost:8787" : location.origin);

const KEY = "okayed.session.v0";

export function loadSession(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Session | null;
    return s?.userId && (s.ownerToken || s.access) ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null): void {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    // storage blocked: the session lasts as long as the tab
  }
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function parse<T>(r: Response): Promise<T> {
  const json = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new ApiError(r.status, json.error ?? `HTTP ${r.status}`);
  return json;
}

/** Calls the person's own API with their owner token. */
export async function call<T = unknown>(s: Session, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${s.api}/api/u/${s.userId}${path}`, {
    method,
    headers: { authorization: `Bearer ${s.ownerToken}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return parse<T>(r);
}

export async function createUser(api: string, turnstile?: string): Promise<Session> {
  const r = await fetch(`${api}/api/users`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(turnstile ? { turnstile } : {}) });
  const j = await parse<{ userId: string; ownerToken?: string; access?: boolean }>(r);
  return { api, userId: j.userId, ownerToken: j.ownerToken ?? "", ...(j.access ? { access: true } : {}) };
}

/** With Cloudflare Access in front, the person is already known: their okayed, with nothing to sign in to. */
export async function accessSession(api: string): Promise<Session | null> {
  try {
    const r = await fetch(`${api}/api/me`);
    if (!r.ok) return null;
    return await createUser(api);
  } catch {
    return null;
  }
}
