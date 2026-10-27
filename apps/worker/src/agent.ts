import { Agent, type Connection, type ConnectionContext } from "agents";
import {
  DEMO_AGENT,
  DEMO_TARGETS,
  FallbackDrafter,
  HeuristicDrafter,
  KeySigner,
  OkayedError,
  OkayedService,
  OpenAICompatibleDrafter,
  SystemClock,
  cryptoRandom,
  deployWithGrant,
  mergeWithGrant,
  prHead,
  type Drafter,
  type FlowEvent,
  type FlowParams,
  type Lifecycle,
  type MergeInput,
  type RelyingParty,
  type Snapshot,
} from "@okayed/core";
import { parseRes } from "@okayed/engine";
import { KIND, sha256Hex, type Assurance, type NostrEvent } from "@okayed/grant";
import { DurableStore, WorkersAIDrafter } from "./adapters.ts";
import { CloudflarePagesDeployer } from "./cloudflare.ts";
import { QueueNotifier } from "./notify.ts";
import type { Env } from "./env.ts";

export type ApiReply = { status: number; body: unknown };

/** Methods the HTTP router may call, by who is calling. */
const OWNER = ["archive", "transcribe", "passkeyOptions", "addPasskey", "removePasskey", "approvalChallenge", "confirmWithPasskey", "snapshot", "chat", "confirm", "deny", "revoke", "stop", "resume", "addAgent", "removeAgent", "setTargets", "removeRule", "setRules", "setBudgets", "topUp", "events", "pairApprover", "unpairApprover"] as const;
const AGENT = ["submitRequest", "requestStatus", "merge", "deploy"] as const;
const PUBLIC = ["verify", "issuer", "inbox", "answer"] as const;
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
    // Workers AI by default; any OpenAI-compatible endpoint when configured; the heuristic offline or as the fallback.
    const model =
      this.env.DRAFTER === "openai-compatible" && this.env.DRAFT_BASE_URL && this.env.MODEL
        ? new OpenAICompatibleDrafter({ baseUrl: this.env.DRAFT_BASE_URL, model: this.env.MODEL, ...(this.env.DRAFT_API_KEY ? { apiKey: this.env.DRAFT_API_KEY } : {}) })
        : this.env.DRAFTER !== "heuristic" && this.env.AI
          ? new WorkersAIDrafter(this.env.AI, this.env.MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast", this.env.AI_GATEWAY)
          : null;
    const drafter: Drafter = model ? new FallbackDrafter(model, heuristic) : heuristic;
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
      ...(this.env.APPROVER_WAKE ? { notifier: new QueueNotifier(this.env.APPROVER_WAKE) } : {}),
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
    // The Worker sets this only after checking the person's Cloudflare Access identity, and strips it otherwise.
    if (ctx.request.headers.get("x-okayed-owner") === "access") return true;
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
      await this.archiveSoon();
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
      if (this.env.DEMO !== "0") await this.svc.setTargets({ repos: DEMO_TARGETS.repos, sites: DEMO_TARGETS.sites });
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
      case "transcribe":
        return this.reply(() => this.transcribe(a[0]));
      case "archive":
        return this.reply(() => this.archived());
      case "passkeyOptions":
        return this.reply(async () => s.passkeyOptions(this.rp(a[0])));
      case "addPasskey":
        return this.reply(async () => s.addPasskey(this.rp(a[0]), a[1], typeof a[2] === "string" ? a[2] : undefined), 201);
      case "removePasskey":
        return this.reply(() => s.removePasskey(String(a[0])));
      case "approvalChallenge":
        return this.reply(async () => s.approvalChallenge(String(a[0]), this.rp(a[1])));
      case "confirmWithPasskey":
        return this.reply(async () => s.confirmWithPasskey(String(a[0]), this.rp(a[1]), a[2]));
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
      case "pairApprover":
        return this.reply(() => s.pairApprover(a[0], a[1], a[2] ?? undefined), 201);
      case "unpairApprover":
        return this.reply(() => s.unpairApprover(String(a[0])));
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
          const out = await s.submitRequest(agentId, input);
          this.metric("request", out.status, out.request.act);
          return out;
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
      case "deploy":
        return this.reply(async () => {
          const deployer = this.deployer();
          if (!deployer) throw new OkayedError(501, "real deploys aren't configured here (CF_ACCOUNT_ID, CF_API_TOKEN, CF_PAGES_SITES)");
          const b = (args[0] ?? {}) as { grant?: unknown; site?: unknown; env?: unknown };
          const out = await deployWithGrant(s, deployer, { grant: b.grant, aud: agentId, host: String(b.site ?? ""), env: String(b.env ?? "") });
          this.metric("deploy", out.ok ? "deployed" : out.stage, "site.deploy");
          if (!out.ok) throw new OkayedError(out.stage === "deploy" ? 502 : 403, out.reason);
          return out;
        });
    }
  }

  async openApi(method: PublicMethod, args: unknown[]): Promise<ApiReply> {
    if (!PUBLIC.includes(method)) return { status: 404, body: { error: "no such method" } };
    if (method === "issuer") return this.reply(async () => ({ issuer: this.svc.issuer, kinds: KIND }));
    // Approver apps authenticate themselves: a NIP-98 signature to read the inbox, a signed answer to reply.
    if (method === "inbox") return this.reply(() => this.svc.inbox(typeof args[0] === "string" ? args[0] : null, String(args[1])));
    if (method === "answer") return this.reply(() => this.svc.answer(args[0]));
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

  /**
   * The relying party for a passkey ceremony: only origins this deployment serves its web app from. The Worker's own
   * origin always counts; the router marks it, since only the router sees the request URL.
   */
  private rp(o: unknown): RelyingParty {
    const same = typeof o === "object" && o !== null && (o as { same?: unknown }).same === true;
    const origin = same ? (o as { origin: unknown }).origin : o;
    const allowed = (this.env.WEB_ORIGINS ?? "http://localhost:5173,http://localhost:5174").split(",").map((x) => x.trim()).filter(Boolean);
    if (typeof origin !== "string" || (!same && !allowed.includes(origin))) throw new OkayedError(400, `passkeys work from ${allowed.join(" or ")}`);
    return { origin, rpID: new URL(origin).hostname, rpName: "okayed" };
  }

  // ---------- Cloudflare extras: metrics, the event archive, voice, real deploys ----------

  /** One Analytics Engine data point per decision: what kind, how it went, which action. */
  private metric(kind: string, outcome: string, act = ""): void {
    this.env.METRICS?.writeDataPoint({ blobs: [kind, outcome, act], doubles: [1], indexes: [this.name] });
  }

  private archivePending = false;

  /** Every signed event goes to R2 as well, a little after it happens (one batch per quiet moment). */
  private async archiveSoon(): Promise<void> {
    if (!this.env.ARCHIVE || this.archivePending) return;
    this.archivePending = true;
    await this.schedule(5, "archiveEvents");
  }

  async archiveEvents(): Promise<void> {
    this.archivePending = false;
    const bucket = this.env.ARCHIVE;
    if (!bucket) return;
    const done = new Set((await this.ctx.storage.get<string[]>("archived")) ?? []);
    const fresh = (await this.svc.events()).filter((e) => !done.has(e.id));
    for (const e of fresh) {
      await bucket.put(`${this.name}/${e.kind}/${e.created_at}-${e.id}.json`, JSON.stringify(e), { httpMetadata: { contentType: "application/json" }, customMetadata: { kind: String(e.kind) } });
    }
    if (fresh.length) await this.ctx.storage.put("archived", [...done, ...fresh.map((e) => e.id)].slice(-2000));
  }

  /** What the R2 archive holds for this person: every signed event, by kind. */
  private async archived(): Promise<{ events: { key: string; kind: number; size: number }[] }> {
    if (!this.env.ARCHIVE) throw new OkayedError(501, "the R2 archive isn't configured here");
    const list = await this.env.ARCHIVE.list({ prefix: `${this.name}/`, include: ["customMetadata"] });
    return { events: list.objects.map((o) => ({ key: o.key.slice(this.name.length + 1), kind: Number(o.customMetadata?.kind ?? 0), size: o.size })) };
  }

  /** Speech to text for voice okays: Whisper on Workers AI. The words then go through drafting like typed ones. */
  private async transcribe(audio: unknown): Promise<{ text: string }> {
    if (!this.env.AI) throw new OkayedError(501, "Voice needs Workers AI, which isn't available in this environment.");
    if (typeof audio !== "string" || !audio || audio.length > 8_000_000) throw new OkayedError(400, "send audio as base64, up to about 6 MB");
    const out = (await this.env.AI.run("@cf/openai/whisper-large-v3-turbo" as keyof AiModels, { audio } as never, this.env.AI_GATEWAY ? { gateway: { id: this.env.AI_GATEWAY } } : undefined)) as { text?: string };
    return { text: (out.text ?? "").trim() };
  }

  private deployer(): CloudflarePagesDeployer | null {
    const { CF_ACCOUNT_ID: account, CF_API_TOKEN: token, CF_PAGES_SITES: sites } = this.env;
    if (!account || !token || !sites) return null;
    return new CloudflarePagesDeployer({ accountId: account, token, sites: JSON.parse(sites), ...(this.env.CF_PAGES_WRITE_GROUP ? { permissionGroup: this.env.CF_PAGES_WRITE_GROUP } : {}) });
  }

  // ---------- RPC from the demo chat (Assistant's tools) ----------

  async demoRequest(input: { act: string; res: string[]; why: string; ref: string }) {
    const out = await this.svc.submitRequest(DEMO_AGENT, input);
    this.metric("request", out.status, input.act);
    await this.broadcastSnapshot();
    return { status: out.status, ...(out.reason ? { reason: out.reason } : {}), ...(out.cardId ? { cardId: out.cardId } : {}) };
  }

  async demoByRef(ref: string) {
    return this.svc.requestByRef(DEMO_AGENT, ref);
  }

  /** Spends the grant for a simulated action. The demo's checks are always green. */
  async demoUse(event: NostrEvent, act: string, res: string) {
    const r = await this.svc.verify({ event, aud: DEMO_AGENT, act, res, consume: true, facts: { "checks.pass": true } });
    await this.broadcastSnapshot();
    return r.ok ? { ok: true as const, left: r.left, ...(r.receipt ? { receipt: r.receipt } : {}) } : { ok: false as const, reason: r.reason };
  }

  async demoPropose(sentence: string) {
    const card = await this.svc.chat(sentence);
    await this.broadcastSnapshot();
    return { cardId: card.id, kind: card.kind, sentence: card.sentence };
  }

  // ---------- RPC from the Workflow (FlowTarget) ----------

  async flowProposed(id: string) {
    return this.svc.proposed(id);
  }
  async flowIssue(id: string, assurance: Assurance) {
    const out = await this.svc.issue(id, assurance);
    this.metric("issued", assurance.method);
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
