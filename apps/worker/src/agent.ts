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
  cloudflareAccess,
  cryptoRandom,
  enablePacks,
  handleApi,
  oidcBearer,
  personOf,
  staticCredential,
  type Connector,
  type Drafter,
  type FlowEvent,
  type FlowParams,
  type Lifecycle,
  type PersonIssuer,
  type RelyingParty,
  type Snapshot,
} from "@okayed/core";
import { cloudflareDnsEdit, cloudflarePagesDeploy, cloudflareToken, githubAppCredential, githubMerge, prHead, slackPost, zoneScope } from "@okayed/connectors";
import { parseRes, type Layer } from "@okayed/engine";
import { readRichRequests } from "@okayed/interop";
import { sha256Hex, type Assurance, type NostrEvent } from "@okayed/grant";
import { DurableStore, WorkersAIDrafter } from "./adapters.ts";
import { QueueNotifier } from "./notify.ts";
import type { Env } from "./env.ts";

export type ApiReply = { status: number; body: unknown };

/** Who can stand in for the owner token: Cloudflare Access, or any OIDC provider, when configured. */
export function issuersFor(env: Env): PersonIssuer[] {
  const out: PersonIssuer[] = [];
  if (env.ACCESS_TEAM && env.ACCESS_AUD) out.push(cloudflareAccess(env.ACCESS_TEAM, env.ACCESS_AUD));
  if (env.OIDC_ISSUER && env.OIDC_AUDIENCE) out.push(oidcBearer(env.OIDC_ISSUER, env.OIDC_AUDIENCE));
  return out;
}

/** The tools this deployment can act through, from its configuration. */
function connectorsFor(env: Env): Connector<any>[] {
  const out: Connector<any>[] = [];
  const github = env.GITHUB_APP_ID && env.GITHUB_APP_KEY && env.GITHUB_APP_INSTALLATION
    ? githubAppCredential({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_KEY, installationId: env.GITHUB_APP_INSTALLATION, permissions: { pull_requests: "write", contents: "write", checks: "read" } })
    : env.GITHUB_TOKEN
      ? staticCredential(env.GITHUB_TOKEN)
      : null;
  if (github) out.push(githubMerge({ credential: github }));
  if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN && env.CF_PAGES_SITES) {
    const credential = cloudflareToken({ accountId: env.CF_ACCOUNT_ID, token: env.CF_API_TOKEN, permissions: [env.CF_PAGES_WRITE_GROUP ?? "Pages Write"] });
    out.push(cloudflarePagesDeploy({ accountId: env.CF_ACCOUNT_ID, sites: JSON.parse(env.CF_PAGES_SITES), credential }));
  }
  if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN && env.CF_DNS_ZONES) {
    const credential = cloudflareToken({ accountId: env.CF_ACCOUNT_ID, token: env.CF_API_TOKEN, permissions: ["DNS Write"], resources: zoneScope });
    out.push(cloudflareDnsEdit({ zones: JSON.parse(env.CF_DNS_ZONES), credential }));
  }
  if (env.SLACK_BOT_TOKEN && env.SLACK_WORKSPACE) out.push(slackPost({ workspace: env.SLACK_WORKSPACE, credential: staticCredential(env.SLACK_BOT_TOKEN) }));
  return out;
}

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
    enablePacks({ ids: this.env.CAPABILITY_PACKS, json: this.env.CAPABILITY_PACKS_JSON });
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

  /** Mints an agent for an OAuth client the person just allowed (the Connect screen). */
  async mintAgent(name: string): Promise<{ id: string; token: string }> {
    const out = await this.svc.addAgent(name);
    await this.broadcastSnapshot();
    return out;
  }

  /** Limits from outside the person: their organization's, from its directory or their sign-in. Never the person's API. */
  async setLimits(id: string, layer: Layer | null): Promise<void> {
    await this.svc.setCeiling(id, layer);
    await this.broadcastSnapshot();
  }

  /** The organization removed or deactivated the person: take back everything. Nothing to do if they never signed in. */
  async orgStop(reason: string): Promise<void> {
    if (!(await this.svc.exists())) return;
    await this.svc.stop(reason);
    await this.broadcastSnapshot();
  }

  /**
   * The person's HTTP API: okayed core's platform-neutral handler, with Cloudflare's pieces as hooks: Access as proof
   * of the person, connectors for real actions, rate limits, metrics, voice and the R2 archive.
   */
  async api(req: Request): Promise<Response> {
    const path = /^\/api\/u\/[0-9a-f]{32}(\/.*)$/.exec(new URL(req.url).pathname)?.[1] ?? "/";
    return handleApi(this.svc, req, path, {
      connectors: connectorsFor(this.env),
      relyingParty: (o, r) => this.rp(o, r),
      isOwner: async (r) => (await personOf(r, issuersFor(this.env)))?.userId === this.name,
      allowAgent: async (agent) => !this.env.AGENT_LIMIT || (await this.env.AGENT_LIMIT.limit({ key: `${this.name}:${agent}` })).success,
      readRequest: readRichRequests(),
      beforeRequest: (input) => this.checkHeads(input),
      extra: async (route, { body }) => {
        if (route === "POST /transcribe") return this.transcribe(body.audio);
        if (route === "GET /archive") return this.archived();
        return undefined;
      },
      changed: async () => {
        await this.broadcastSnapshot();
        await this.archiveSoon();
      },
      observe: (kind, outcome, act) => this.metric(kind, outcome, act),
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
   * The relying party for a passkey ceremony: only origins this deployment serves its web app from, the Worker's own
   * origin first.
   */
  private rp(origin: unknown, req: Request): RelyingParty {
    const own = new URL(req.url).origin;
    const allowed = [own, ...(this.env.WEB_ORIGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean)];
    if (typeof origin !== "string" || !allowed.includes(origin)) throw new OkayedError(400, `passkeys work from ${allowed.join(" or ")}`);
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
    if (this.env.CHAT_LIMIT && !(await this.env.CHAT_LIMIT.limit({ key: `ai:${this.name}` })).success) throw new OkayedError(429, "Too much at once. Try again in a minute.");
    const out = (await this.env.AI.run("@cf/openai/whisper-large-v3-turbo" as keyof AiModels, { audio } as never, this.env.AI_GATEWAY ? { gateway: { id: this.env.AI_GATEWAY } } : undefined)) as { text?: string };
    return { text: (out.text ?? "").trim() };
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
