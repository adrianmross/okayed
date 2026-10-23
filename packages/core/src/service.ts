import {
  BASELINE,
  CATALOG,
  canonRes,
  checkUse,
  decideAll,
  DEFAULT_USER_LAYER,
  describeRequestSentence,
  describeRule,
  fitsAction,
  narrowGrant,
  parseRes,
  sentenceFor,
  type GrantDraft,
  type Layer,
  type Policy,
  type Request,
  type Targets,
} from "@okayed/engine";
import {
  buildGrant,
  grantTemplate,
  openGrantEvent,
  policyTemplate,
  receiptTemplate,
  requestTemplate,
  revokeTemplate,
  sha256Hex,
  stopTemplate,
  type Assurance,
  type NostrEvent,
} from "@okayed/grant";
import { chatCard, draftOf, grantCard } from "./cards.ts";
import type { FlowTarget } from "./flow.ts";
import type { Clock, DraftContext, Drafter, Lifecycle, Randomness, Signer, Store } from "./ports.ts";
import {
  OkayedError,
  type AgentRecord,
  type AuditEntry,
  type Card,
  type ChatMessage,
  type GrantRecord,
  type Meta,
  type RequestRecord,
  type RequestStatus,
  type Snapshot,
  type VerifyInput,
  type VerifyResult,
} from "./records.ts";
import { buildSnapshot } from "./views.ts";

export interface ServiceDeps {
  userId: string;
  store: Store;
  clock: Clock;
  signer: Signer;
  drafter: Drafter;
  lifecycle: Lifecycle;
  random: Randomness;
}

const AUDIT_MAX = 300;
const CHAT_MAX = 100;
const REQUEST_TTL = 30 * 60;
const CHAT_CARD_WAIT = 30 * 60;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "agent";
}

/**
 * One person's okayed: policy, pending requests, cards, grants, audit. Every method runs against that person's
 * store only. Model calls happen outside transactions; decisions inside them are the engine's.
 */
export class OkayedService implements FlowTarget {
  constructor(private d: ServiceDeps) {}

  get userId(): string {
    return this.d.userId;
  }

  /** This user's issuer key: the `iss` of every grant, and the key verifiers should trust. */
  get issuer(): string {
    return this.d.signer.pubkey;
  }

  async now(): Promise<number> {
    return this.d.clock.now();
  }

  // ---------- identity ----------

  /** Creates the user on first call and returns the owner token; later calls return null. */
  async claim(): Promise<string | null> {
    return this.d.store.transaction(async (tx) => {
      if (await tx.get<Meta>("meta")) return null;
      const token = `own_${this.d.random.hex(24)}`;
      const meta: Meta = { userId: this.d.userId, createdAt: this.d.clock.now(), ownerTokenHash: sha256Hex(token), paused: false };
      await tx.put("meta", meta);
      await tx.put("layer", DEFAULT_USER_LAYER);
      await tx.put<Targets>("targets", { repos: [], prs: [], sites: [], agents: [] });
      return token;
    });
  }

  async isOwner(token: string | null | undefined): Promise<boolean> {
    if (!token) return false;
    const meta = await this.d.store.get<Meta>("meta");
    return !!meta && meta.ownerTokenHash === sha256Hex(token);
  }

  async addAgent(name: string): Promise<{ id: string; token: string }> {
    const token = `agt_${this.d.random.hex(24)}`;
    return this.d.store.transaction(async (tx) => {
      const existing = await tx.list<AgentRecord>("agent:");
      let id = `agent:${slug(name)}`;
      for (let i = 2; existing.has(id); i++) id = `agent:${slug(name)}-${i}`;
      await tx.put<AgentRecord>(id, { id, name: name.slice(0, 64), tokenHash: sha256Hex(token), createdAt: this.d.clock.now() });
      const t = await this.targets(tx);
      t.agents = [...new Set([...t.agents, id])];
      await tx.put("targets", t);
      await this.audit(tx, { type: "agent", text: `Added agent ${id}.`, ref: id });
      return { id, token };
    });
  }

  async removeAgent(id: string): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      await tx.delete(id);
      const t = await this.targets(tx);
      t.agents = t.agents.filter((a) => a !== id);
      await tx.put("targets", t);
      await this.audit(tx, { type: "agent", text: `Removed agent ${id}; its token no longer works.`, ref: id });
    });
  }

  async agentFor(token: string | null | undefined): Promise<string | null> {
    if (!token) return null;
    const h = sha256Hex(token);
    for (const a of (await this.d.store.list<AgentRecord>("agent:")).values()) if (a.tokenHash === h) return a.id;
    return null;
  }

  async setTargets(t: Partial<Pick<Targets, "repos" | "sites">>): Promise<Targets> {
    return this.d.store.transaction(async (tx) => {
      const cur = await this.targets(tx);
      if (t.repos) cur.repos = [...new Set(t.repos.map((r) => r.toLowerCase().trim()).filter((r) => /^[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*$/.test(r)))];
      if (t.sites) {
        cur.sites = t.sites
          .map((s) => ({ host: s.host.toLowerCase().trim(), envs: [...new Set(s.envs.map((e) => e.toLowerCase().trim()).filter(Boolean))] }))
          .filter((s) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s.host) && s.envs.length);
      }
      await tx.put("targets", cur);
      return cur;
    });
  }

  /** Records a PR's head commit, as looked up by the caller (ideally from GitHub, not from the agent). */
  async notePr(repo: string, number: number, head: string): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      const t = await this.targets(tx);
      t.prs = [...t.prs.filter((p) => !(p.repo === repo && p.number === number)), { repo, number, head: head.toLowerCase() }].slice(-50);
      if (!t.repos.includes(repo)) t.repos.push(repo);
      await tx.put("targets", t);
    });
  }

  // ---------- requests from agents ----------

  async submitRequest(agentId: string, input: { act?: unknown; res?: unknown; why?: unknown; ttl?: unknown }): Promise<{ request: Request; status: RequestStatus | "approving"; cardId?: string; reason?: string }> {
    const act = typeof input.act === "string" ? input.act : "";
    if (!CATALOG[act]) throw new OkayedError(400, `unknown action "${act}"; known: ${Object.keys(CATALOG).join(", ")}`);
    const rawRes = Array.isArray(input.res) ? input.res : typeof input.res === "string" ? [input.res] : [];
    if (rawRes.length < 1 || rawRes.length > 10) throw new OkayedError(400, "res must name 1 to 10 exact resources");
    const res: string[] = [];
    for (const r of rawRes) {
      const c = typeof r === "string" ? canonRes(r) : null;
      if (!c || !fitsAction(act, c)) throw new OkayedError(400, `"${String(r)}" is not an exact resource for ${act}`);
      res.push(c);
    }
    const now = this.d.clock.now();
    const ttl = typeof input.ttl === "number" && input.ttl > 0 ? Math.min(Math.floor(input.ttl), 86400) : REQUEST_TTL;
    const request: Request = {
      id: `r_${this.d.random.hex(8)}`,
      aud: agentId,
      act,
      res,
      why: typeof input.why === "string" ? input.why.slice(0, 280) : "",
      at: now,
      exp: now + ttl,
    };
    const event = await this.d.signer.sign(requestTemplate(request));

    const out = await this.d.store.transaction(async (tx) => {
      const meta = await this.meta(tx);
      await this.learn(tx, request);
      const policy = await this.policy(tx);
      const targets = await this.targets(tx);
      const result = narrowGrant({ utterance: "", proposal: request, requests: [request], targets, policy, now, select: request.id });
      const rec: RequestRecord = { request, status: "pending" };
      await this.audit(tx, { type: "request", text: describeRequestSentence(request), ref: request.id, event });
      if (result.kind !== "grant") {
        rec.status = "denied";
        rec.reason = result.kind === "refuse" ? result.reason : result.question;
        await tx.put(`req:${request.id}`, rec);
        await this.audit(tx, { type: "deny", text: `Refused ${request.id}: ${rec.reason}`, ref: request.id });
        return { rec, card: null as Card | null, auto: false };
      }
      const card = grantCard(`c_${this.d.random.hex(8)}`, result, "request", now);
      const auto = result.decision.verdict === "allow" && !meta.paused;
      if (auto) card.status = "confirming";
      rec.cardId = card.id;
      await tx.put(`req:${request.id}`, rec);
      await tx.put(`card:${card.id}`, card);
      return { rec, card, auto };
    });

    if (out.card) {
      await this.d.lifecycle.start(out.card.id, { userId: this.d.userId, proposalId: out.card.id, waitSeconds: request.exp - now, auto: out.auto });
      if (!out.auto) await this.attachExplanation(out.card);
    }
    const status = out.auto ? "approving" : out.rec.status;
    const reply: { request: Request; status: RequestStatus | "approving"; cardId?: string; reason?: string } = { request, status };
    if (out.card) reply.cardId = out.card.id;
    if (out.rec.reason) reply.reason = out.rec.reason;
    return reply;
  }

  async requestStatus(agentId: string, id: string): Promise<{ status: RequestStatus; reason?: string; grant?: NostrEvent } | null> {
    const rec = await this.d.store.get<RequestRecord>(`req:${id}`);
    if (!rec || rec.request.aud !== agentId) return null;
    const status = rec.status === "pending" && rec.request.exp <= this.d.clock.now() ? "expired" : rec.status;
    const out: { status: RequestStatus; reason?: string; grant?: NostrEvent } = { status };
    if (rec.reason) out.reason = rec.reason;
    if (rec.grantId) {
      const g = await this.d.store.get<GrantRecord>(`grant:${rec.grantId}`);
      if (g) out.grant = g.event;
    }
    return out;
  }

  // ---------- chat ----------

  async chat(utterance: string): Promise<Card> {
    const text = utterance.trim().slice(0, 2000);
    if (!text) throw new OkayedError(400, "say something");
    const now = this.d.clock.now();
    const ctx = await this.draftContext(now);
    await this.d.store.transaction((tx) => this.say(tx, { role: "person", text }));
    const draft = await this.d.drafter.draft(text, ctx);

    const card = await this.d.store.transaction(async (tx) => {
      const policy = await this.policy(tx);
      const targets = await this.targets(tx);
      const pending = draft.intent === "grant" ? await this.pendingRequests(tx, now) : [];
      const card = chatCard(`c_${this.d.random.hex(8)}`, text, draft, { policy, targets, pending, now });
      card.drafter = this.d.drafter.name;
      await tx.put(`card:${card.id}`, card);
      await this.say(tx, { role: "okayed", text: card.sentence, cardId: card.id });
      return card;
    });

    if (card.kind === "grant") {
      await this.d.lifecycle.start(card.id, { userId: this.d.userId, proposalId: card.id, waitSeconds: CHAT_CARD_WAIT, auto: false });
    }
    if (card.kind === "grant" || card.kind === "policy") await this.attachExplanation(card);
    return (await this.d.store.get<Card>(`card:${card.id}`)) ?? card;
  }

  // ---------- the person's decisions ----------

  async confirm(cardId: string, assurance: Assurance["method"] = "web-click", proof?: unknown): Promise<Card> {
    const now = this.d.clock.now();
    const card = await this.d.store.transaction(async (tx) => {
      const card = await tx.get<Card>(`card:${cardId}`);
      if (!card) throw new OkayedError(404, "no such card");
      if (card.status !== "open") throw new OkayedError(409, `this card is ${card.status}`);
      if (card.kind === "policy") {
        const layer = await tx.get<Layer>("layer") ?? DEFAULT_USER_LAYER;
        const next: Layer = { ...layer, rules: [...layer.rules.filter((r) => r.until === undefined || r.until > now), ...(card.rules ?? [])] };
        await tx.put("layer", next);
        card.status = "confirmed";
        await tx.put(`card:${cardId}`, card);
        const event = await this.d.signer.sign(policyTemplate({ layers: [BASELINE, next] }, now));
        await this.audit(tx, { type: "policy", text: `Policy changed: ${(card.ruleTexts ?? []).join("; ")}.`, ref: cardId, event });
        return card;
      }
      if (card.kind !== "grant") throw new OkayedError(409, "nothing to confirm");
      card.status = "confirming";
      await tx.put(`card:${cardId}`, card);
      return card;
    });
    if (card.kind === "grant") {
      const a: { method: "web-click" | "webauthn" | "approver"; at: number; proof?: unknown } = { method: assurance === "policy" ? "web-click" : assurance, at: now };
      if (proof !== undefined) a.proof = proof;
      await this.d.lifecycle.send(cardId, { type: "decision", decision: "confirm", assurance: a });
    }
    return (await this.d.store.get<Card>(`card:${cardId}`)) ?? card;
  }

  async deny(cardId: string): Promise<Card> {
    const card = await this.d.store.get<Card>(`card:${cardId}`);
    if (!card) throw new OkayedError(404, "no such card");
    if (card.status !== "open") throw new OkayedError(409, `this card is ${card.status}`);
    if (card.kind === "grant") {
      await this.d.lifecycle.send(cardId, { type: "decision", decision: "deny" });
    } else {
      await this.d.store.transaction(async (tx) => {
        card.status = "denied";
        await tx.put(`card:${cardId}`, card);
        await this.audit(tx, { type: "deny", text: `Declined: ${card.sentence}`, ref: cardId });
      });
    }
    return (await this.d.store.get<Card>(`card:${cardId}`)) ?? card;
  }

  async revoke(grantId: string, reason = "revoked by you"): Promise<GrantRecord> {
    const now = this.d.clock.now();
    const event = await this.d.signer.sign(revokeTemplate({ v: 0, grant: grantId, reason, at: now }));
    const rec = await this.d.store.transaction(async (tx) => {
      const rec = await tx.get<GrantRecord>(`grant:${grantId}`);
      if (!rec) throw new OkayedError(404, "no such grant");
      if (rec.status !== "active") return rec;
      rec.status = "revoked";
      rec.revokedAt = now;
      rec.revokeReason = reason;
      await tx.put(`grant:${grantId}`, rec);
      await this.audit(tx, { type: "revoke", text: `Revoked: ${sentenceFor(draftOf(rec.grant))} (${reason})`, ref: grantId, event });
      return rec;
    });
    await this.d.lifecycle.send(rec.cardId, { type: "revoke", reason });
    return rec;
  }

  /** Emergency stop: revoke every live grant and pause auto-approval. */
  async stop(reason = "emergency stop"): Promise<number> {
    const now = this.d.clock.now();
    const event = await this.d.signer.sign(stopTemplate({ v: 0, reason, at: now }));
    const revoked = await this.d.store.transaction(async (tx) => {
      const meta = await this.meta(tx);
      meta.stoppedAt = now;
      meta.paused = true;
      await tx.put("meta", meta);
      const out: GrantRecord[] = [];
      for (const [key, rec] of await tx.list<GrantRecord>("grant:")) {
        if (rec.status !== "active") continue;
        rec.status = "revoked";
        rec.revokedAt = now;
        rec.revokeReason = reason;
        await tx.put(key, rec);
        out.push(rec);
      }
      await this.audit(tx, { type: "stop", text: `Emergency stop: revoked ${out.length} grant(s) and paused auto-approval.`, event });
      return out;
    });
    for (const rec of revoked) await this.d.lifecycle.send(rec.cardId, { type: "revoke", reason });
    return revoked.length;
  }

  async resume(): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      const meta = await this.meta(tx);
      meta.paused = false;
      await tx.put("meta", meta);
      await this.audit(tx, { type: "resume", text: "Auto-approval resumed." });
    });
  }

  async removeRule(ruleId: string): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      const layer = (await tx.get<Layer>("layer")) ?? DEFAULT_USER_LAYER;
      const rule = layer.rules.find((r) => r.id === ruleId);
      if (!rule) throw new OkayedError(404, "no such rule");
      await tx.put("layer", { ...layer, rules: layer.rules.filter((r) => r.id !== ruleId) });
      await this.audit(tx, { type: "policy", text: `Removed rule: ${describeRule(rule, this.d.clock.now())}.`, ref: ruleId });
    });
  }

  // ---------- verification ----------

  async verify(input: VerifyInput): Promise<VerifyResult> {
    const now = this.d.clock.now();
    let id = input.grantId;
    if (input.event !== undefined) {
      const opened = openGrantEvent(input.event, [this.d.signer.pubkey]);
      if (!opened.ok) return { ok: false, code: "bad_event", reason: opened.reason };
      id = opened.grant.id;
    }
    if (!id) return { ok: false, code: "unknown_grant", reason: "pass the grant event or its id" };
    const grantId = id;

    const result = await this.d.store.transaction(async (tx): Promise<VerifyResult & { use?: number }> => {
      const rec = await tx.get<GrantRecord>(`grant:${grantId}`);
      if (!rec) return { ok: false, code: "unknown_grant", reason: "this issuer never issued that grant" };
      if (input.event !== undefined && (input.event as NostrEvent).id !== rec.event.id) {
        return { ok: false, code: "bad_event", reason: "the event is not the one this issuer published" };
      }
      const meta = await this.meta(tx);
      const state = { revoked: rec.status === "revoked", used: rec.used, issuedAt: rec.grant.nbf, ...(meta.stoppedAt !== undefined ? { stoppedAt: meta.stoppedAt } : {}) };
      const check = checkUse(rec.grant, { aud: input.aud, act: input.act, res: input.res, now }, state, input.facts ?? {});
      if (!check.ok) {
        await this.audit(tx, { type: "verify", text: `Refused a use of ${grantId.slice(0, 8)}: ${check.reason}.`, ref: grantId });
        return check;
      }
      if (!input.consume) return { ok: true, grant: grantId, left: rec.grant.uses - rec.used };
      rec.used += 1;
      if (rec.used >= rec.grant.uses) rec.status = "used";
      await tx.put(`grant:${grantId}`, rec);
      await this.audit(tx, { type: "use", text: `Used ${grantId.slice(0, 8)}: ${input.act} on ${input.res} (${check.left} left).`, ref: grantId });
      return { ok: true, grant: grantId, left: check.left, use: rec.used };
    });
    if (!result.ok || !result.use) {
      const { use: _u, ...rest } = result as VerifyResult & { use?: number };
      return rest as VerifyResult;
    }
    const receipt = await this.d.signer.sign(receiptTemplate({ v: 0, grant: grantId, use: result.use, left: result.left, act: input.act, res: canonRes(input.res) ?? input.res, at: now }));
    await this.d.store.transaction((tx) => this.audit(tx, { type: "receipt", text: `Receipt for use ${result.use} of ${grantId.slice(0, 8)}.`, ref: grantId, event: receipt }));
    return { ok: true, grant: grantId, left: result.left, receipt };
  }

  // ---------- lifecycle steps (called by the flow; all idempotent) ----------

  async proposed(cardId: string): Promise<{ open: boolean }> {
    const card = await this.d.store.get<Card>(`card:${cardId}`);
    return { open: !!card && (card.status === "open" || card.status === "confirming") };
  }

  async issue(cardId: string, assurance: Assurance): Promise<{ grantId: string; exp: number } | null> {
    const now = this.d.clock.now();
    const card = await this.d.store.get<Card>(`card:${cardId}`);
    if (!card || card.kind !== "grant" || !card.draft) return null;
    if (card.grantId) {
      const rec = await this.d.store.get<GrantRecord>(`grant:${card.grantId}`);
      return rec ? { grantId: rec.grant.id, exp: rec.grant.exp } : null;
    }
    if (card.status !== "confirming") return null;
    const ttl = card.ttl ?? card.draft.exp - card.draft.nbf;
    const draft: GrantDraft = { ...card.draft, nbf: now, exp: now + ttl };
    const grant = buildGrant(draft, this.d.signer.pubkey, assurance, this.d.random.hex(8));
    const event = await this.d.signer.sign(grantTemplate(grant));

    return this.d.store.transaction(async (tx) => {
      const c = await tx.get<Card>(`card:${cardId}`);
      if (!c || c.status !== "confirming") return null;
      const meta = await this.meta(tx);
      const close = async (reason: string) => {
        c.status = "closed";
        c.closedReason = reason;
        await tx.put(`card:${cardId}`, c);
        await this.audit(tx, { type: "deny", text: `Not issued: ${reason}`, ref: cardId });
        return null;
      };
      if (assurance.method === "policy" && meta.paused) return close("auto-approval is paused after an emergency stop");
      const decision = decideAll(await this.policy(tx), draft.act, draft.res, now);
      if (decision.verdict === "deny") return close(decision.reason);
      if (assurance.method === "policy" && decision.verdict !== "allow") return close("policy no longer auto-approves this");
      let req: RequestRecord | undefined;
      if (draft.from.request) {
        req = await tx.get<RequestRecord>(`req:${draft.from.request}`);
        if (!req || req.status !== "pending") return close("the request is no longer pending");
        if (req.request.exp <= now) return close("the request expired");
      }
      await tx.put<GrantRecord>(`grant:${grant.id}`, { grant, event, cardId, used: 0, status: "active" });
      c.status = "confirmed";
      c.grantId = grant.id;
      await tx.put(`card:${cardId}`, c);
      if (req) {
        req.status = "granted";
        req.grantId = grant.id;
        await tx.put(`req:${req.request.id}`, req);
        // Other cards for the same request are moot now.
        for (const [key, other] of await tx.list<Card>("card:")) {
          if (other.id !== cardId && other.requestId === req.request.id && other.status === "open") {
            other.status = "closed";
            other.closedReason = "answered by another card";
            await tx.put(key, other);
          }
        }
      }
      const how = assurance.method === "policy" ? "auto-approved by your policy" : `confirmed (${assurance.method})`;
      await this.audit(tx, { type: "grant", text: `Issued, ${how}: ${sentenceFor(draft)}`, ref: grant.id, event });
      return { grantId: grant.id, exp: grant.exp };
    });
  }

  async lapse(cardId: string): Promise<void> {
    await this.closeCard(cardId, "lapsed", "No answer in time; the proposal lapsed.");
  }

  async decline(cardId: string): Promise<void> {
    await this.closeCard(cardId, "denied", "You declined.");
  }

  async expire(grantId: string): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      const rec = await tx.get<GrantRecord>(`grant:${grantId}`);
      if (!rec || rec.status !== "active") return;
      if (this.d.clock.now() < rec.grant.exp) return;
      rec.status = "expired";
      await tx.put(`grant:${grantId}`, rec);
      await this.audit(tx, { type: "expire", text: `Expired: ${sentenceFor(draftOf(rec.grant))}`, ref: grantId });
    });
  }

  async revoked(grantId: string, reason: string): Promise<void> {
    await this.d.store.transaction((tx) => this.audit(tx, { type: "lifecycle", text: `Lifecycle for ${grantId.slice(0, 8)} closed: ${reason}.`, ref: grantId }));
  }

  // ---------- views ----------

  async snapshot(): Promise<Snapshot> {
    const s = this.d.store;
    const who = { userId: this.d.userId, issuer: this.d.signer.pubkey, drafter: this.d.drafter.name };
    return buildSnapshot(s, who, await this.meta(s), await this.policy(s), await this.targets(s), this.d.clock.now());
  }

  async events(): Promise<NostrEvent[]> {
    const audit = (await this.d.store.get<AuditEntry[]>("audit")) ?? [];
    return audit.flatMap((a) => (a.event ? [a.event] : []));
  }

  // ---------- internals ----------

  private async attachExplanation(card: Card): Promise<void> {
    const facts = [
      card.sentence,
      card.risk ? `Risk: ${card.risk}.` : "",
      card.beyond.length ? `Cut from the draft: ${card.beyond.map((b) => `${b.asked} (${b.why})`).join("; ")}.` : "",
      card.decision ? `Policy: ${card.decision.reason}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    let explanation: string | null = null;
    try {
      explanation = await this.d.drafter.explain(facts);
    } catch {
      explanation = null;
    }
    if (!explanation) return;
    await this.d.store.transaction(async (tx) => {
      const c = await tx.get<Card>(`card:${card.id}`);
      if (!c) return;
      c.explanation = explanation.slice(0, 600);
      await tx.put(`card:${card.id}`, c);
    });
  }

  private async closeCard(cardId: string, status: "lapsed" | "denied", text: string): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      const card = await tx.get<Card>(`card:${cardId}`);
      if (!card || (card.status !== "open" && card.status !== "confirming")) return;
      card.status = status;
      await tx.put(`card:${cardId}`, card);
      if (card.source === "request" && card.requestId) {
        const req = await tx.get<RequestRecord>(`req:${card.requestId}`);
        if (req && req.status === "pending") {
          req.status = status === "denied" ? "denied" : "expired";
          req.reason = text;
          await tx.put(`req:${card.requestId}`, req);
        }
      }
      await this.audit(tx, { type: status === "denied" ? "deny" : "lapse", text: `${text} ${card.sentence}`, ref: cardId });
    });
  }

  private async draftContext(now: number): Promise<DraftContext> {
    const s = this.d.store;
    const pending = await this.pendingRequests(s, now);
    return {
      now,
      targets: await this.targets(s),
      pending: pending.map((r) => ({ id: r.id, sentence: describeRequestSentence(r), act: r.act, res: r.res })),
      actions: Object.keys(CATALOG),
    };
  }

  private async pendingRequests(tx: Pick<Store, "list">, now: number): Promise<Request[]> {
    return [...(await tx.list<RequestRecord>("req:")).values()].filter((r) => r.status === "pending" && r.request.exp > now).map((r) => r.request);
  }

  private async meta(tx: Pick<Store, "get">): Promise<Meta> {
    const meta = await tx.get<Meta>("meta");
    if (!meta) throw new OkayedError(404, "no such user");
    return meta;
  }

  private async policy(tx: Pick<Store, "get">): Promise<Policy> {
    return { layers: [BASELINE, (await tx.get<Layer>("layer")) ?? DEFAULT_USER_LAYER] };
  }

  private async targets(tx: Pick<Store, "get">): Promise<Targets> {
    return (await tx.get<Targets>("targets")) ?? { repos: [], prs: [], sites: [], agents: [] };
  }

  /** Requests teach the binder which targets exist; they never decide anything. */
  private async learn(tx: Omit<Store, "transaction">, r: Request): Promise<void> {
    const t = await this.targets(tx);
    for (const s of r.res) {
      const x = parseRes(s);
      if (!x) continue;
      if (x.kind === "github.repo" || x.kind === "github.pr") {
        const repo = `${x.owner}/${x.repo}`;
        if (!t.repos.includes(repo)) t.repos.push(repo);
        if (x.kind === "github.pr" && x.sha && !t.prs.some((p) => p.repo === repo && p.number === x.number)) {
          t.prs.push({ repo, number: x.number, head: x.sha });
        }
      } else if (x.kind === "site") {
        const site = t.sites.find((y) => y.host === x.host);
        if (!site) t.sites.push({ host: x.host, envs: [x.env] });
        else if (!site.envs.includes(x.env)) site.envs.push(x.env);
      }
    }
    if (!t.agents.includes(r.aud)) t.agents.push(r.aud);
    await tx.put("targets", t);
  }

  private async audit(tx: Pick<Store, "get" | "put">, e: Omit<AuditEntry, "at">): Promise<void> {
    const log = (await tx.get<AuditEntry[]>("audit")) ?? [];
    log.push({ at: this.d.clock.now(), ...e });
    await tx.put("audit", log.slice(-AUDIT_MAX));
  }

  private async say(tx: Pick<Store, "get" | "put">, m: Omit<ChatMessage, "at">): Promise<void> {
    const log = (await tx.get<ChatMessage[]>("chat")) ?? [];
    log.push({ at: this.d.clock.now(), ...m });
    await tx.put("chat", log.slice(-CHAT_MAX));
  }
}
