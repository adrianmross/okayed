import { getAgentByName } from "agents";
import type { ApiReply } from "./agent.ts";
import type { Env } from "./env.ts";

/**
 * OAuth consent for remote MCP clients. `/authorize` binds a consent to this browser (a cookie from the OAuth
 * library) and hands the person to the web app's Connect screen, which knows who they are. Approving there mints an
 * agent for the client and completes the authorization, so the client's token acts as that agent and nothing more.
 */
export async function consent(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const url = new URL(req.url);
  if (!oauth) return Response.json({ error: "OAuth isn't configured" }, { status: 501 });

  if (req.method === "GET" && url.pathname === "/authorize") {
    const authReq = await oauth.parseAuthRequest(req);
    const d = await oauth.describeConsent(authReq);
    const tx = await oauth.beginConsent(authReq);
    const to = new URL("/", url);
    to.hash = `connect?${new URLSearchParams({ h: tx.handle, client: d.clientName, to: new URL(d.redirectUri).host })}`;
    const headers = new Headers(tx.headers);
    headers.set("location", to.toString());
    return new Response(null, { status: 302, headers });
  }

  const body = (await req.json().catch(() => ({}))) as { h?: unknown; user?: unknown };
  const handle = typeof body.h === "string" ? body.h : "";

  if (req.method === "POST" && url.pathname === "/authorize/deny") {
    const denied = await oauth.denyConsent(req, handle);
    return Response.json({ redirectTo: denied.redirectTo }, { headers: denied.headers });
  }

  if (req.method === "POST" && url.pathname === "/authorize/approve") {
    const user = typeof body.user === "string" && /^[0-9a-f]{32}$/.test(body.user) ? body.user : null;
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
    if (!user) return Response.json({ error: "who is approving?" }, { status: 400 });
    const stub = await getAgentByName(env.OkayedAgent, user);
    if (!(await stub.isOwner(token))) return Response.json({ error: "unauthorized" }, { status: 401 });
    const approved = await oauth.approveConsent(req, handle);
    const client = await oauth.lookupClient(approved.request.clientId);
    const minted = (await stub.ownerApi("addAgent", [client?.clientName ?? "mcp client"])) as unknown as ApiReply;
    if (minted.status !== 201) return Response.json(minted.body, { status: minted.status });
    const agent = minted.body as { id: string; token: string };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: user,
      metadata: { agent: agent.id, client: client?.clientName ?? null },
      scope: approved.request.scope,
      props: { userId: user, agentId: agent.id, agentToken: agent.token } satisfies McpProps,
    });
    return Response.json({ redirectTo, agent: agent.id }, { headers: approved.headers });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

/** What an MCP session acts as: one agent of one person. Encrypted at rest by the OAuth library. */
export interface McpProps extends Record<string, unknown> {
  userId: string;
  agentId: string;
  agentToken: string;
}
