export interface Session {
  api: string;
  userId: string;
  ownerToken: string;
}

const KEY = "okayed.session.v0";

export function loadSession(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Session | null;
    return s?.userId && s.ownerToken ? s : null;
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

export async function createUser(api: string): Promise<Session> {
  const j = await parse<{ userId: string; ownerToken: string }>(await fetch(`${api}/api/users`, { method: "POST" }));
  return { api, userId: j.userId, ownerToken: j.ownerToken };
}
