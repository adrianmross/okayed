/**
 * The agent's side of okayed: ask before acting, wait for the person (or their policy), then act with the grant.
 * No dependencies; pass your own `fetch` to run anywhere.
 */

export interface NostrEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface Grant {
  id: string;
  act: string;
  res: string[];
  aud: string;
  exp: number;
  uses: number;
  when: { c: string; v?: string | number }[];
  assurance: { method: string; at: number; policy?: string[] };
}

export type Status = "pending" | "granted" | "denied" | "expired";

export interface Answer {
  request: string;
  status: Status;
  reason?: string;
  /** The signed grant event, once granted: hand it to the tool. */
  event?: NostrEvent;
  /** The grant inside the event, parsed for convenience; the tool verifies the signature, not this copy. */
  grant?: Grant;
}

export interface ClientOptions {
  /** e.g. https://okayed.example.workers.dev */
  api: string;
  /** The person's okayed user id. */
  user: string;
  /** The agent token the person minted (agt_…). */
  token: string;
  fetch?: typeof fetch;
}

export class OkayedError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class OkayedClient {
  private readonly o: ClientOptions;
  private readonly f: typeof fetch;
  constructor(o: ClientOptions) {
    this.o = o;
    this.f = o.fetch ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.f(`${this.o.api.replace(/\/$/, "")}/api/u/${this.o.user}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (!r.ok) throw new OkayedError(r.status, json.error ?? `HTTP ${r.status}`);
    return json;
  }

  private answer(request: string, st: { status: Status; reason?: string; grant?: NostrEvent }): Answer {
    const out: Answer = { request, status: st.status };
    if (st.reason) out.reason = st.reason;
    if (st.grant) {
      out.event = st.grant;
      out.grant = JSON.parse(st.grant.content) as Grant;
    }
    return out;
  }

  /** Files a request for one exact action. A standing policy may grant it at once; otherwise the person decides. */
  async request(act: string, res: string[], why = "", ttl?: number): Promise<Answer> {
    const r = await this.call<{ request: { id: string }; status: Status | "approving"; reason?: string }>("POST", "/requests", { act, res, why, ...(ttl ? { ttl } : {}) });
    const status: Status = r.status === "approving" ? "pending" : r.status;
    return this.answer(r.request.id, { status, ...(r.reason ? { reason: r.reason } : {}) });
  }

  /** The request's state now, long-polling up to `waitSeconds` (max 20) for it to leave pending. */
  async status(request: string, waitSeconds = 0): Promise<Answer> {
    const st = await this.call<{ status: Status; reason?: string; grant?: NostrEvent }>("GET", `/requests/${request}?wait=${Math.min(20, Math.max(0, waitSeconds))}`);
    return this.answer(request, st);
  }

  /** Waits until the request is decided or `timeoutSeconds` pass; returns the last answer either way. */
  async waitFor(request: string, timeoutSeconds = 300): Promise<Answer> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (;;) {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      const a = await this.status(request, Math.min(20, Math.max(0, left)));
      if (a.status !== "pending" || left <= 0) return a;
    }
  }

  /** Request, then wait: the one call most agents need before acting. */
  async ask(act: string, res: string[], why = "", timeoutSeconds = 300): Promise<Answer> {
    const first = await this.request(act, res, why);
    return first.status === "pending" ? this.waitFor(first.request, timeoutSeconds) : first;
  }

  /** Merges a PR through okayed's tool: it verifies and spends the grant, then merges with a token you never hold. */
  async merge(event: NostrEvent, pr: { owner: string; repo: string; number: number; sha: string; method?: "merge" | "squash" | "rebase" }): Promise<{ merged: true; sha: string; left: number }> {
    return this.call("POST", "/tools/github/merge", { grant: event, ...pr });
  }

  /** Deploys a site environment through okayed's tool: Cloudflare Pages, with a token minted for this one deploy. */
  async deploy(event: NostrEvent, target: { site: string; env: string }): Promise<{ deployed: true; id: string; url?: string; left: number }> {
    return this.call("POST", "/tools/cloudflare/deploy", { grant: event, ...target });
  }
}

/** The exact resource for a PR at a commit, as okayed names it. */
export function prResource(owner: string, repo: string, number: number, sha: string): string {
  return `github:${owner}/${repo}/pull/${number}@${sha.toLowerCase()}`;
}
