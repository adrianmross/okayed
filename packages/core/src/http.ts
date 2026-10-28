import { KIND } from "@okayed/grant";
import { performWithGrant, type Connector } from "./connectors.ts";
import { bearerOf } from "./identity.ts";
import type { RelyingParty } from "./passkeys.ts";
import { OkayedError } from "./records.ts";
import type { OkayedService } from "./service.ts";

/**
 * okayed's HTTP API for one person, on any runtime with the Fetch API's Request and Response: a Cloudflare Durable
 * Object, a Node server, Deno, Bun. Routes are relative to the person (`/api/u/<user>` on the wire). The platform
 * plugs in identity, tools and its own extras through hooks.
 */

export type Caller = { kind: "owner" } | { kind: "agent"; agent: string } | { kind: "anyone" };

export interface ApiHooks {
  /** Tools agents act through, at POST /tools/<connector id>. */
  connectors?: Connector<any>[];
  /** Turns the browser's claimed origin into a passkey relying party, or throws. Same-origin only by default. */
  relyingParty?: (origin: unknown, req: Request) => RelyingParty;
  /** Other proof that the caller is the person (Cloudflare Access, an OIDC ID token…), besides the owner token. */
  isOwner?: (req: Request) => Promise<boolean>;
  /** Rate limits and the like, per agent. Return false to refuse with 429. */
  allowAgent?: (agent: string) => Promise<boolean>;
  /** Runs before an agent's request is filed, e.g. to check a PR's head commit against GitHub. */
  beforeRequest?: (input: Record<string, unknown>) => Promise<void>;
  /** The platform's own routes (voice, archives…). Return undefined when the route isn't theirs. */
  extra?: (route: string, ctx: { req: Request; caller: Caller; body: Record<string, unknown>; url: URL }) => Promise<unknown>;
  /** After anything that may have changed state, e.g. to push a fresh snapshot to open tabs. */
  changed?: () => Promise<void>;
  /** One event per decision, for metrics. */
  observe?: (kind: string, outcome: string, act?: string) => void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "DELETE") return {};
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The default relying party: only the origin this API is served from. */
export function sameOrigin(origin: unknown, req: Request): RelyingParty {
  const own = new URL(req.url).origin;
  if (origin !== own) throw new OkayedError(400, `passkeys work from ${own}`);
  return { origin: own, rpID: new URL(own).hostname, rpName: "okayed" };
}

/** Handles one call to a person's okayed. `path` is everything after `/api/u/<user>`, e.g. `/requests`. */
export async function handleApi(svc: OkayedService, req: Request, path: string, hooks: ApiHooks = {}): Promise<Response> {
  const url = new URL(req.url);
  try {
    const out = await route(svc, req, path, url, hooks);
    if (out instanceof Response) return out;
    return json(out.body ?? { ok: true }, out.status);
  } catch (e) {
    if (e instanceof OkayedError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: e instanceof Error ? e.message : "internal error" }, 500);
  }
}

async function route(svc: OkayedService, req: Request, path: string, url: URL, h: ApiHooks): Promise<Response | { status: number; body: unknown }> {
  const r = `${req.method} ${path}`;
  const token = bearerOf(req);
  const ok = (body: unknown, status = 200) => ({ status, body });
  const changed = async <T>(p: Promise<T>, status = 200) => {
    const body = await p;
    await h.changed?.();
    return ok(body, status);
  };

  // Anyone: verifying grants, the issuer key, and approver apps (who sign their own calls).
  if (r === "GET /issuer") return ok({ issuer: svc.issuer, kinds: KIND });
  if (r === "POST /verify") {
    const b = await readBody(req);
    if (typeof b.aud !== "string" || typeof b.act !== "string" || typeof b.res !== "string") throw new OkayedError(400, "verify needs aud, act and res");
    if (b.consume === true && b.event === undefined) throw new OkayedError(400, "spending a use needs the grant event, not just its id");
    const input: Parameters<OkayedService["verify"]>[0] = { aud: b.aud, act: b.act, res: b.res, consume: b.consume === true };
    if (b.event !== undefined) input.event = b.event;
    if (typeof b.grantId === "string") input.grantId = b.grantId;
    if (b.facts && typeof b.facts === "object") input.facts = b.facts as never;
    return changed(svc.verify(input));
  }
  if (r === "GET /approvers/inbox") return ok(await svc.inbox(req.headers.get("authorization"), req.url));
  if (r === "POST /approvals") {
    const b = await readBody(req);
    return changed(svc.answer(b.event ?? b));
  }

  // Agents: an okayed agent token, or a trusted workload's identity token.
  const isOwner = (await svc.isOwner(token)) || ((await h.isOwner?.(req)) ?? false);
  const agent = !isOwner && token ? await svc.agentFor(token) : null;
  if (agent) {
    if (h.allowAgent && !(await h.allowAgent(agent))) throw new OkayedError(429, "too many requests; slow down");
    const b = await readBody(req);
    if (r === "POST /requests") {
      await h.beforeRequest?.(b);
      const out = await svc.submitRequest(agent, b);
      h.observe?.("request", out.status, out.request.act);
      await h.changed?.();
      return ok(out, 202);
    }
    const rq = /^GET \/requests\/(r_[0-9a-f]+)$/.exec(r);
    if (rq) {
      const wait = Math.min(Math.max(Number(url.searchParams.get("wait")) || 0, 0), 20);
      const deadline = Date.now() + wait * 1000;
      for (;;) {
        const st = await svc.requestStatus(agent, rq[1]!);
        if (!st) throw new OkayedError(404, "no such request");
        if (st.status !== "pending" || Date.now() >= deadline) return ok(st);
        await new Promise((res) => setTimeout(res, 500));
      }
    }
    const tool = /^POST \/tools\/(.+)$/.exec(r);
    const c = tool && h.connectors?.find((x) => x.id === tool[1]);
    if (tool) {
      if (!c) throw new OkayedError(501, `there's no ${tool[1]} tool here`);
      const out = await performWithGrant(svc, c, b, agent);
      h.observe?.("tool", out.ok ? "done" : out.stage, c.act);
      await h.changed?.();
      if (!out.ok) throw new OkayedError(out.stage === "input" ? 400 : out.stage === "action" || out.stage === "credential" ? 502 : 403, out.reason);
      return ok(out);
    }
    throw new OkayedError(404, "not found");
  }

  // The person.
  if (!isOwner) throw new OkayedError(401, "unauthorized");
  const caller: Caller = { kind: "owner" };
  const b = await readBody(req);
  const rp = (o: unknown) => (h.relyingParty ?? sameOrigin)(o, req);
  let x: RegExpExecArray | null;
  if (r === "GET /state") return ok(await svc.snapshot());
  if (r === "GET /events") return ok(await svc.events());
  if (r === "POST /chat") return changed(svc.chat(String(b.text ?? "")));
  if (r === "POST /stop") return changed(svc.stop(typeof b.reason === "string" && b.reason ? b.reason : undefined).then((revoked) => ({ revoked })));
  if (r === "POST /resume") return changed(svc.resume());
  if (r === "POST /agents") return changed(svc.addAgent(String(b.name ?? "agent")), 201);
  if (r === "POST /trusts") return changed(svc.trustWorkload(b), 201);
  if (r === "PUT /targets") return changed(svc.setTargets(b as never));
  if (r === "PUT /policy") return changed(svc.setRules(b.rules));
  if (r === "PUT /budgets") return changed(svc.setBudgets(b.budgets));
  if (r === "POST /passkeys/options") return ok(await svc.passkeyOptions(rp(b.origin)));
  if (r === "POST /passkeys") return changed(svc.addPasskey(rp(b.origin), b.response, typeof b.name === "string" ? b.name : undefined), 201);
  if (r === "POST /approvers") return changed(svc.pairApprover(b.pubkey, b.name, b.wake ?? undefined), 201);
  if ((x = /^POST \/cards\/(c_[0-9a-f]+)\/challenge$/.exec(r))) return ok(await svc.approvalChallenge(x[1]!, rp(b.origin)));
  if ((x = /^POST \/cards\/(c_[0-9a-f]+)\/confirm$/.exec(r))) return changed(b.assertion ? svc.confirmWithPasskey(x[1]!, rp(b.origin), b.assertion) : svc.confirm(x[1]!, "web-click"));
  if ((x = /^POST \/cards\/(c_[0-9a-f]+)\/deny$/.exec(r))) return changed(svc.deny(x[1]!));
  if ((x = /^DELETE \/passkeys\/([A-Za-z0-9_-]+)$/.exec(r))) return changed(svc.removePasskey(x[1]!));
  if ((x = /^DELETE \/approvers\/([0-9a-f]{64})$/.exec(r))) return changed(svc.unpairApprover(x[1]!));
  if ((x = /^POST \/grants\/([0-9a-f]{64})\/revoke$/.exec(r))) return changed(svc.revoke(x[1]!, typeof b.reason === "string" && b.reason ? b.reason : undefined));
  const decoded = decodeURIComponent(r);
  if ((x = /^DELETE \/agents\/(agent:[a-z0-9-]+)$/.exec(decoded))) return changed(svc.removeAgent(x[1]!));
  if ((x = /^POST \/rules\/(.+)\/topup$/.exec(decoded))) return changed(svc.topUp(x[1]!));
  if ((x = /^DELETE \/rules\/(.+)$/.exec(decoded))) return changed(svc.removeRule(x[1]!));
  const extra = await h.extra?.(r, { req, caller, body: b, url });
  if (extra !== undefined) {
    await h.changed?.();
    return extra instanceof Response ? extra : ok(extra);
  }
  throw new OkayedError(404, "not found");
}
