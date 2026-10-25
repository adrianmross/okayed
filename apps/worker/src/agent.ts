import { Agent, type Connection, type ConnectionContext } from "agents";
import {
  FallbackDrafter,
  HeuristicDrafter,
  KeySigner,
  OkayedError,
  OkayedService,
  SystemClock,
  cryptoRandom,
  mergeWithGrant,
  prHead,
  type Drafter,
  type FlowEvent,
  type FlowParams,
  type Lifecycle,
  type MergeInput,
  type Snapshot,
} from "@okayed/core";
import { parseRes } from "@okayed/engine";
import { KIND, sha256Hex, type Assurance } from "@okayed/grant";
import { DurableStore, WorkersAIDrafter } from "./adapters.ts";
import type { Env } from "./env.ts";

export type ApiReply = { status: number; body: unknown };

/** Methods the HTTP router may call, by who is calling. */
const OWNER = ["snapshot", "chat", "confirm", "deny", "revoke", "stop", "resume", "addAgent", "removeAgent", "setTargets", "removeRule", "setRules", "setBudgets", "topUp", "events"] as const;
const AGENT = ["submitRequest", "requestStatus", "merge"] as const;
const PUBLIC = ["verify", "issuer"] as const;
export type OwnerMethod = (typeof OWNER)[number];
export type AgentMethod = (typeof AGENT)[number];
export type PublicMethod = (typeof PUBLIC)[number];

/**
 * One person's okayed, as an Agents SDK agent: a Durable Object named by the user id. It holds policy,
 * requests, cards, grants and the audit log, and syncs a snapshot to the person's open tabs over WebSocket.
 */
export class OkayedAgent extends Agent<Env, Snapshot | null> {
  initialState: Snapshot | null = null;
  private _svc?: OkayedService;

  private get svc(): OkayedService {
    if (this._svc) return this._svc;
    if (!/^[0-9a-f]{64}$/.test(this.env.ISSUER_SECRET ?? "")) throw new OkayedError(500, "ISSUER_SECRET must be 64 hex characters");
    const heuristic = new HeuristicDrafter();
    const drafter: Drafter =
      this.env.DRAFTER === "heuristic" || !this.env.AI
        ? heuristic
        : new FallbackDrafter(new WorkersAIDrafter(this.env.AI, this.env.MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast"), heuristic);
    const lifecycle: Lifecycle = {
      start: async (id: string, params: FlowParams) => {
        await this.runWorkflow("GRANT_LIFECYCLE", params, { id });
      },
      send: async (id: string, event: FlowEvent) => {
        try {
          await this.sendWorkflowEvent("GRANT_LIFECYCLE", id, { type: event.type, payload: event });
        } catch {
          // The flow already finished; the state change itself is already stored.
        }
      },
    };
    this._svc = new OkayedService({
      userId: this.name,
      store: new DurableStore(this.ctx.storage),
      clock: new SystemClock(),
      signer: KeySigner.forUser(this.env.ISSUER_SECRET, this.name),
      drafter,
      lifecycle,
      random: cryptoRandom,
    });
    return this._svc;
  }

  // ---------- WebSocket: live state for the person's tabs ----------

  /** Hash of the owner token, cached so the synchronous protocol check below can use it. */
  private ownerHash: string | null = null;

  async onStart(): Promise<void> {
    this.ownerHash = (await this.ctx.storage.get<{ ownerTokenHash: string }>("meta"))?.ownerTokenHash ?? null;
  }

  private ownsConnection(ctx: ConnectionContext): boolean {
    const token = new URL(ctx.request.url).searchParams.get("token");
    return !!token && !!this.ownerHash && sha256Hex(token) === this.ownerHash;
  }

  /**
   * The Agents SDK sends identity and state to a socket as soon as it connects, before `onConnect` runs. The
   * Worker already refuses unauthenticated upgrades (`onBeforeConnect`); this keeps the DO from ever sending
   * state to a socket without the owner token, even if something routes one here directly.
   */
  shouldSendProtocolMessages(_conn: Connection, ctx: ConnectionContext): boolean {
    return this.ownsConnection(ctx);
  }

  async onConnect(conn: Connection, ctx: ConnectionContext): Promise<void> {
    if (!this.ownsConnection(ctx)) {
      conn.close(4401, "unauthorized");
      return;
    }
    await this.broadcastSnapshot();
  }

  /** Clients can read state but never write it. */
  validateStateChange(_next: Snapshot | null, source: Connection | "server"): void {
    if (source !== "server") throw new Error("state is read-only");
  }

  private async broadcastSnapshot(): Promise<void> {
    try {
      this.setState(await this.svc.snapshot());
    } catch {
      // No user yet.
    }
  }

  private async reply(fn: () => Promise<unknown>, status = 200): Promise<ApiReply> {
    try {
      const body = await fn();
      await this.broadcastSnapshot();
      return { status, body };
    } catch (e) {
      if (e instanceof OkayedError) return { status: e.status, body: { error: e.message } };
      console.error(e);
      return { status: 500, body: { error: e instanceof Error ? e.message : "internal error" } };
    }
  }

  // ---------- RPC from the router ----------

  async claim(): Promise<ApiReply> {
    return this.reply(async () => {
      const token = await this.svc.claim();
      if (!token) throw new OkayedError(409, "user exists");
      this.ownerHash = sha256Hex(token);
      return { userId: this.name, ownerToken: token, issuer: this.svc.issuer };
    }, 201);
  }

  async isOwner(token: string | null): Promise<boolean> {
    return this.svc.isOwner(token);
  }

  async agentFor(token: string | null): Promise<string | null> {
    return this.svc.agentFor(token);
  }

  async ownerApi(method: OwnerMethod, args: unknown[]): Promise<ApiReply> {
    if (!OWNER.includes(method)) return { status: 404, body: { error: "no such method" } };
    const s = this.svc;
    const a = args as never[];
    switch (method) {
      case "snapshot":
        return this.reply(() => s.snapshot());
      case "chat":
        return this.reply(() => s.chat(String(a[0] ?? "")));
      case "confirm":
        return this.reply(() => s.confirm(String(a[0]), "web-click"));
      case "deny":
        return this.reply(() => s.deny(String(a[0])));
      case "revoke":
        return this.reply(() => s.revoke(String(a[0]), typeof a[1] === "string" && a[1] ? a[1] : undefined));
      case "stop":
        return this.reply(async () => ({ revoked: await s.stop(typeof a[0] === "string" && a[0] ? a[0] : undefined) }));
      case "resume":
        return this.reply(() => s.resume());
      case "addAgent":
        return this.reply(() => s.addAgent(String(a[0] ?? "agent")), 201);
      case "removeAgent":
        return this.reply(() => s.removeAgent(String(a[0])));
      case "setTargets":
        return this.reply(() => s.setTargets((a[0] ?? {}) as never));
      case "removeRule":
        return this.reply(() => s.removeRule(String(a[0])));
      case "setRules":
        return this.reply(() => s.setRules(a[0]));
      case "setBudgets":
        return this.reply(() => s.setBudgets(a[0]));
      case "topUp":
        return this.reply(() => s.topUp(String(a[0])));
      case "events":
        return this.reply(() => s.events());
    }
  }

  async agentApi(agentId: string, method: AgentMethod, args: unknown[]): Promise<ApiReply> {
    if (!AGENT.includes(method)) return { status: 404, body: { error: "no such method" } };
    const s = this.svc;
    switch (method) {
      case "submitRequest":
        return this.reply(async () => {
          const input = (args[0] ?? {}) as { act?: unknown; res?: unknown; why?: unknown; ttl?: unknown };
          await this.checkHeads(input);
          return s.submitRequest(agentId, input);
        }, 202);
      case "requestStatus":
        return this.reply(async () => {
          const id = String(args[0]);
          const wait = Math.min(Math.max(Number(args[1]) || 0, 0), 20);
          const deadline = Date.now() + wait * 1000;
          for (;;) {
            const st = await s.requestStatus(agentId, id);
            if (!st) throw new OkayedError(404, "no such request");
            if (st.status !== "pending" || Date.now() >= deadline) return st;
            await new Promise((r) => setTimeout(r, 500));
          }
        });
      case "merge":
        return this.reply(async () => {
          const input = { ...(args[0] as MergeInput), aud: agentId };
          const out = await mergeWithGrant(s, { github: async () => this.env.GITHUB_TOKEN ?? null }, input);
          if (!out.ok) throw new OkayedError(out.stage === "config" ? 501 : out.stage === "github" ? 502 : 403, out.reason);
          return out;
        });
    }
  }

  async openApi(method: PublicMethod, args: unknown[]): Promise<ApiReply> {
    if (!PUBLIC.includes(method)) return { status: 404, body: { error: "no such method" } };
    if (method === "issuer") return this.reply(async () => ({ issuer: this.svc.issuer, kinds: KIND }));
    return this.reply(async () => {
      const body = (args[0] ?? {}) as { event?: unknown; grantId?: unknown; aud?: unknown; act?: unknown; res?: unknown; consume?: unknown; facts?: unknown };
      if (typeof body.aud !== "string" || typeof body.act !== "string" || typeof body.res !== "string") {
        throw new OkayedError(400, "verify needs aud, act and res");
      }
      if (body.consume === true && body.event === undefined) throw new OkayedError(400, "spending a use needs the grant event, not just its id");
      const input: Parameters<OkayedService["verify"]>[0] = { aud: body.aud, act: body.act, res: body.res, consume: body.consume === true };
      if (body.event !== undefined) input.event = body.event;
      if (typeof body.grantId === "string") input.grantId = body.grantId;
      if (body.facts && typeof body.facts === "object") input.facts = body.facts as never;
      return this.svc.verify(input);
    });
  }

  /** With a GitHub token, a merge request must name the PR's real head commit; the binder then learns it from GitHub. */
  private async checkHeads(input: { act?: unknown; res?: unknown }): Promise<void> {
    const token = this.env.GITHUB_TOKEN;
    if (!token || input.act !== "github.pr.merge" || !Array.isArray(input.res)) return;
    for (const r of input.res) {
      const x = typeof r === "string" ? parseRes(r) : null;
      if (x?.kind !== "github.pr" || !x.sha) continue;
      const head = await prHead(fetch, token, x.owner, x.repo, x.number);
      if (!head) continue;
      if (head.toLowerCase() !== x.sha) throw new OkayedError(409, `PR #${x.number} is at ${head.slice(0, 7)}, not ${x.sha.slice(0, 7)}`);
      await this.svc.notePr(`${x.owner}/${x.repo}`, x.number, head);
    }
  }

  // ---------- RPC from the Workflow (FlowTarget) ----------

  async flowProposed(id: string) {
    return this.svc.proposed(id);
  }
  async flowIssue(id: string, assurance: Assurance) {
    const out = await this.svc.issue(id, assurance);
    await this.broadcastSnapshot();
    return out;
  }
  async flowLapse(id: string) {
    await this.svc.lapse(id);
    await this.broadcastSnapshot();
  }
  async flowDecline(id: string) {
    await this.svc.decline(id);
    await this.broadcastSnapshot();
  }
  async flowExpire(grantId: string) {
    await this.svc.expire(grantId);
    await this.broadcastSnapshot();
  }
  async flowRevoked(grantId: string, reason: string) {
    await this.svc.revoked(grantId, reason);
    await this.broadcastSnapshot();
  }
}
