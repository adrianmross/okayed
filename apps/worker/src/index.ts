import { getAgentByName, routeAgentRequest } from "agents";
import type { AgentMethod, ApiReply, OwnerMethod } from "./agent.ts";
import type { Env } from "./env.ts";

export { OkayedAgent } from "./agent.ts";
export { GrantLifecycle } from "./workflow.ts";

/**
 * HTTP API. The person's browser uses an owner token; agents use agent tokens minted by the person; anyone may
 * verify a grant. Everything for a user is handled by that user's Durable Object.
 */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });
}

function send(r: ApiReply): Response {
  return json(r.body ?? { ok: true }, r.status);
}

function bearer(req: Request): string | null {
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
    "POST /api/users": "create a user; returns userId and ownerToken",
    "GET /api/u/:user/state": "owner: policy, cards, requests, grants, audit",
    "POST /api/u/:user/chat": "owner: { text }",
    "POST /api/u/:user/cards/:card/confirm|deny": "owner",
    "POST /api/u/:user/grants/:grant/revoke": "owner: { reason? }",
    "POST /api/u/:user/stop | /resume": "owner: emergency stop / resume auto-approval",
    "POST /api/u/:user/agents": "owner: { name } → agent token (shown once)",
    "PUT /api/u/:user/targets": "owner: { repos?, sites? }",
    "PUT /api/u/:user/policy": "owner: { rules } replaces your standing policies",
    "PUT /api/u/:user/budgets": "owner: { budgets } shared budgets, global or scoped (none by default)",
    "POST /api/u/:user/rules/:key/topup": "owner: reset what a policy (rule id) or shared budget (budget:<id>) has spent",
    "POST /api/u/:user/requests": "agent: { act, res[], why, ttl? }",
    "GET /api/u/:user/requests/:id?wait=10": "agent: status, and the grant event once issued",
    "POST /api/u/:user/tools/github/merge": "agent: { grant, owner, repo, number, sha } — merges using okayed's token",
    "POST /api/u/:user/verify": "anyone: { event | grantId, aud, act, res, consume? }",
    "GET /api/u/:user/issuer": "anyone: the user's issuer key",
  },
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);

    if (url.pathname.startsWith("/agents/")) {
      // Only the person's own browser may open the live-state socket: check the owner token before upgrading.
      const res = await routeAgentRequest(req, env, {
        cors: true,
        onBeforeConnect: async (r) => {
          const name = /^\/agents\/okayed-agent\/([0-9a-f]{32})$/.exec(new URL(r.url).pathname)?.[1];
          if (!name) return json({ error: "not found" }, 404);
          const stub = await getAgentByName(env.OkayedAgent, name);
          if (!(await stub.isOwner(new URL(r.url).searchParams.get("token")))) return json({ error: "unauthorized" }, 401);
          return undefined;
        },
        onBeforeRequest: () => json({ error: "not found" }, 404),
      });
      return res ?? json({ error: "not found" }, 404);
    }
    if (url.pathname === "/" || url.pathname === "/api") return json(INFO);
    if (url.pathname === "/api/users" && req.method === "POST") {
      const id = newUserId();
      const stub = await getAgentByName(env.OkayedAgent, id);
      return send(await stub.claim());
    }

    const m = /^\/api\/u\/([0-9a-f]{32})(\/.*)$/.exec(url.pathname);
    if (!m) return json({ error: "not found" }, 404);
    const [, userId, rest] = m as unknown as [string, string, string];
    const stub = await getAgentByName(env.OkayedAgent, userId);
    const token = bearer(req);
    const b = await body(req);
    const route = `${req.method} ${rest}`;

    // Anyone.
    if (route === "POST /verify") return send(await stub.openApi("verify", [b]));
    if (route === "GET /issuer") return send(await stub.openApi("issuer", []));

    // Agents.
    if (token?.startsWith("agt_")) {
      const agentId = await stub.agentFor(token);
      if (!agentId) return json({ error: "unknown agent token" }, 401);
      const call = (method: AgentMethod, args: unknown[]) => (stub.agentApi(agentId, method, args) as unknown as Promise<ApiReply>).then(send);
      if (route === "POST /requests") return call("submitRequest", [b]);
      const rq = /^GET \/requests\/(r_[0-9a-f]+)$/.exec(route);
      if (rq) return call("requestStatus", [rq[1], url.searchParams.get("wait")]);
      if (route === "POST /tools/github/merge") return call("merge", [b]);
      return json({ error: "not found" }, 404);
    }

    // The person.
    if (!(await stub.isOwner(token))) return json({ error: "unauthorized" }, 401);
    const call = (method: OwnerMethod, args: unknown[] = []) => (stub.ownerApi(method, args) as unknown as Promise<ApiReply>).then(send);
    if (route === "GET /state") return call("snapshot");
    if (route === "GET /events") return call("events");
    if (route === "POST /chat") return call("chat", [b.text]);
    if (route === "POST /stop") return call("stop", [b.reason]);
    if (route === "POST /resume") return call("resume");
    if (route === "POST /agents") return call("addAgent", [b.name]);
    if (route === "PUT /targets") return call("setTargets", [b]);
    if (route === "PUT /policy") return call("setRules", [b.rules]);
    if (route === "PUT /budgets") return call("setBudgets", [b.budgets]);
    let x: RegExpExecArray | null;
    if ((x = /^POST \/cards\/(c_[0-9a-f]+)\/(confirm|deny)$/.exec(route))) return call(x[2] === "confirm" ? "confirm" : "deny", [x[1]]);
    if ((x = /^POST \/grants\/([0-9a-f]{64})\/revoke$/.exec(route))) return call("revoke", [x[1], b.reason]);
    if ((x = /^DELETE \/agents\/(agent:[a-z0-9-]+)$/.exec(decodeURIComponent(route)))) return call("removeAgent", [x[1]]);
    if ((x = /^POST \/rules\/(.+)\/topup$/.exec(decodeURIComponent(route)))) return call("topUp", [x[1]]);
    if ((x = /^DELETE \/rules\/(.+)$/.exec(decodeURIComponent(route)))) return call("removeRule", [x[1]]);
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
