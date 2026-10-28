import { getAgentByName, routeAgentRequest } from "agents";
import { personOf } from "@okayed/core";
import { issuersFor, type ApiReply } from "./agent.ts";
import { consent } from "./consent.ts";
import type { Env } from "./env.ts";

/**
 * The HTTP API, the live sockets and the web app. The person's browser uses an owner token; agents use agent tokens
 * minted by the person; anyone may verify a grant. Everything for a user is handled by that user's Durable Object.
 * Static assets (the web app, the playground, the shadcn registry) are served by Workers Static Assets.
 */

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });
}

function send(r: ApiReply): Response {
  return json(r.body ?? { ok: true }, r.status);
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "DELETE") return {};
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** With Cloudflare Access (or another OIDC provider) in front, the okayed the person's identity owns; otherwise null. */
async function accessUser(req: Request, env: Env): Promise<string | null> {
  const issuers = issuersFor(env);
  return issuers.length ? ((await personOf(req, issuers))?.userId ?? null) : null;
}

/** Turnstile's verdict on the token the welcome page sent. */
async function human(secret: string, token: unknown, ip: string | null): Promise<boolean> {
  if (typeof token !== "string" || !token) return false;
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  return r.ok && ((await r.json()) as { success?: boolean }).success === true;
}

/**
 * The shadcn registry's items name each other by URL. The build writes a placeholder origin, and this fills in the
 * one the registry is served from, so it works on workers.dev, a custom domain or localhost alike.
 */
async function registryItem(req: Request, url: URL, assets: Fetcher): Promise<Response> {
  const r = await assets.fetch(req);
  if (!r.ok) return r;
  const body = (await r.text()).replaceAll("__OKAYED_ORIGIN__", url.origin);
  return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "public, max-age=300" } });
}

function newUserId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const INFO = {
  name: "okayed",
  what: "Scoped-authority approvals for AI agents: plain-language okays become exact, signed, expiring grants.",
  docs: "https://github.com/adrianmross/okayed",
  api: {
    "POST /api/users": "create a user; returns userId and ownerToken (with Access: your user, no token)",
    "GET /api/me": "with Cloudflare Access: the user your identity owns",
    "/mcp": "remote MCP server (OAuth: /authorize, /token, /register)",
    "GET /api/u/:user/state": "owner: policy, cards, requests, grants, audit",
    "POST /api/u/:user/chat": "owner: { text }",
    "POST /api/u/:user/cards/:card/challenge": "owner: { origin } → passkey options bound to this exact request",
    "POST /api/u/:user/cards/:card/confirm": "owner: { origin, assertion } approves with a passkey; without one, a plain okay",
    "POST /api/u/:user/cards/:card/deny": "owner",
    "POST /api/u/:user/passkeys/options | /passkeys": "owner: set up Face ID / Touch ID for approving",
    "POST /api/u/:user/approvers": "owner: { pubkey, name } pairs an approver app on another device",
    "GET /api/u/:user/approvers/inbox": "approver app, signed (NIP-98): approvals waiting for it",
    "POST /api/u/:user/approvals": "approver app: { event } a signed kind-4845 answer",
    "WS /agents/okayed-chat/:user?token=": "owner: the demo chat (Agents SDK AIChatAgent)",
    "POST /api/u/:user/grants/:grant/revoke": "owner: { reason? }",
    "POST /api/u/:user/stop | /resume": "owner: take back every permission and pause rules / resume them",
    "POST /api/u/:user/agents": "owner: { name } → agent token (shown once)",
    "PUT /api/u/:user/targets": "owner: { repos?, sites? }",
    "PUT /api/u/:user/policy": "owner: { rules } replaces your rules",
    "PUT /api/u/:user/budgets": "owner: { budgets } limits shared across rules, global or scoped (none by default)",
    "POST /api/u/:user/rules/:key/topup": "owner: reset what a rule (its id) or a shared limit (budget:<id>) has used",
    "POST /api/u/:user/requests": "agent: { act, res[], why, ttl? }",
    "GET /api/u/:user/requests/:id?wait=10": "agent: status, and the grant event once issued",
    "POST /api/u/:user/tools/github/merge": "agent: { grant, owner, repo, number, sha } — merges using okayed's token",
    "POST /api/u/:user/tools/cloudflare/deploy": "agent: { grant, site, env } — deploys a Pages project with a just-in-time Cloudflare API token",
    "POST /api/u/:user/transcribe": "owner: { audio: base64 } → { text } (Whisper on Workers AI)",
    "GET /api/u/:user/archive": "owner: the signed events archived in R2",
    "POST /api/u/:user/verify": "anyone: { event | grantId, aud, act, res, consume? }",
    "GET /api/u/:user/issuer": "anyone: the user's issuer key",
  },
};

export const app = {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === "/authorize" || url.pathname.startsWith("/authorize/")) return consent(req, env);

    if (url.pathname.startsWith("/agents/")) {
      // Only the person's own browser may reach their live state or their chat: the owner token, or their Access
      // identity. The Durable Object trusts x-okayed-owner only because every request reaches it through here.
      const fwd = new Request(req);
      fwd.headers.delete("x-okayed-owner");
      const pathUser = /^\/agents\/[a-z-]+\/([0-9a-f]{32})/.exec(url.pathname)?.[1];
      if (pathUser && (await accessUser(req, env)) === pathUser) fwd.headers.set("x-okayed-owner", "access");
      const ownerOnly = async (r: Request) => {
        const m = /^\/agents\/(okayed-agent|okayed-chat)\/([0-9a-f]{32})(?:\/.*)?$/.exec(new URL(r.url).pathname);
        if (!m) return json({ error: "not found" }, 404);
        const stub = await getAgentByName(env.OkayedAgent, m[2]!);
        if (r.headers.get("x-okayed-owner") !== "access" && !(await stub.isOwner(new URL(r.url).searchParams.get("token")))) return json({ error: "unauthorized" }, 401);
        // The okayed agent has no HTTP surface; the chat agent serves its message history.
        if (r.headers.get("upgrade")?.toLowerCase() !== "websocket" && m[1] === "okayed-agent") return json({ error: "not found" }, 404);
        return undefined;
      };
      const res = await routeAgentRequest(fwd, env, { cors: true, onBeforeConnect: ownerOnly, onBeforeRequest: ownerOnly });
      return res ?? json({ error: "not found" }, 404);
    }
    if (url.pathname === "/api" || url.pathname === "/api/") return json(INFO);
    if (url.pathname.startsWith("/r/") && url.pathname.endsWith(".json") && env.ASSETS) return registryItem(req, url, env.ASSETS);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS ? env.ASSETS.fetch(req) : json(INFO);
    const ip = req.headers.get("cf-connecting-ip");
    if (url.pathname === "/api/me" && req.method === "GET") {
      const me = await accessUser(req, env);
      return me ? json({ userId: me, access: true }) : json({ access: false }, 404);
    }
    if (url.pathname === "/api/users" && req.method === "POST") {
      if (env.SIGNUP_LIMIT && !(await env.SIGNUP_LIMIT.limit({ key: ip ?? "unknown" })).success) return json({ error: "Too many new accounts from here. Try again in a minute." }, 429);
      const me = await accessUser(req, env);
      if (me) {
        // Access already knows who this is; their okayed is theirs, with no owner token to keep.
        const r = (await (await getAgentByName(env.OkayedAgent, me)).claim()) as unknown as ApiReply;
        return r.status === 201 || r.status === 409 ? json({ userId: me, access: true }) : send(r);
      }
      if (env.TURNSTILE_SECRET && !(await human(env.TURNSTILE_SECRET, (await body(req)).turnstile, ip))) return json({ error: "The challenge didn't pass. Try again." }, 403);
      const id = newUserId();
      const stub = await getAgentByName(env.OkayedAgent, id);
      return send(await stub.claim());
    }

    // Everything else belongs to one person: their Durable Object serves okayed core's HTTP API.
    const m = /^\/api\/u\/([0-9a-f]{32})\//.exec(url.pathname);
    if (!m) return json({ error: "not found" }, 404);
    const stub = await getAgentByName(env.OkayedAgent, m[1]!);
    const res = (await stub.api(req)) as unknown as Response;
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
    return out;
  },
};
