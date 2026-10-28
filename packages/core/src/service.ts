import {
  CATALOG,
  canonRes,
  checkUse,
  decideAll,
  checkBudget,
  checkRule,
  describeRequestSentence,
  describeRule,
  fitsAction,
  labelRes,
  narrowGrant,
  parseRes,
  personalLayer,
  sentenceFor,
  type GrantDraft,
  type Layer,
  type Policy,
  type Request,
  type Rule,
  type SharedBudget,
  type Targets,
  type Usage,
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
import { agentForWorkload, type WorkloadTrust } from "./identity.ts";
import { addedPacks, namesFor } from "./packs.ts";
import { bindingFor, readAnswer, readHttpAuth, type ApprovalBinding, type Notifier, type PairedApprover, type PushedApproval } from "./approvers.ts";
import { approvalOptions, registrationOptions, verifyApproval, verifyRegistration, type RelyingParty, type StoredPasskey } from "./passkeys.ts";
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
  /** Wakes paired approver apps when an approval is waiting for them. Optional: they can also just poll. */
  notifier?: Notifier;
  /** For fetching identity providers' keys; the global fetch by default. */
  fetch?: typeof fetch;
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
  private readonly d: ServiceDeps;
  constructor(d: ServiceDeps) {
    this.d = d;
  }

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
      await tx.put("layer", personalLayer());
      await tx.put<Targets>("targets", { repos: [], prs: [], sites: [], agents: [] });
      return token;
    });
  }

  /** Whether this person's okayed has been claimed. */
  async exists(): Promise<boolean> {
    return !!(await this.d.store.get<Meta>("meta"));
  }

  async isOwner(token: string | null | undefined): Promise<boolean> {
    if (!token) return false;
    const meta = await this.d.store.get<Meta>("meta");
    return !!meta && meta.ownerTokenHash === sha256Hex(token);
  }

  async addAgent(name: string): Promise<{ id: string; token: string }> {
    const token = `agt_${this.d.random.hex(24)}`;
    const id = await this.newAgent(name, { tokenHash: sha256Hex(token) });
    return { id, token };
  }

  /**
   * Trusts a workload to act as a new agent by the identity token its platform issues (GitHub Actions, Kubernetes, a
   * cloud): no okayed token to store in CI. `subject` may use `*`.
   */
  async trustWorkload(input: { issuer?: unknown; subject?: unknown; audience?: unknown; name?: unknown }): Promise<{ id: string }> {
    const { issuer, subject, audience, name } = input;
    if (typeof issuer !== "string" || !/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(issuer)) throw new OkayedError(400, "issuer must be an https URL");
    if (typeof subject !== "string" || !subject.trim() || subject.length > 300) throw new OkayedError(400, "subject is required (use * for any run of characters)");
    if (subject.trim() === "*") throw new OkayedError(400, "a subject of just * would trust every workload of that issuer");
    if (typeof audience !== "string" || !audience.trim()) throw new OkayedError(400, "audience is required");
    const label = typeof name === "string" && name.trim() ? name.trim() : new URL(issuer).hostname.split(".")[1] ?? "workload";
    return { id: await this.newAgent(label, { tokenHash: "", workload: { issuer: issuer.replace(/\/$/, ""), subject: subject.trim(), audience: audience.trim() } }) };
  }

  private async newAgent(name: string, how: Pick<AgentRecord, "tokenHash" | "workload">): Promise<string> {
    return this.d.store.transaction(async (tx) => {
      const existing = await tx.list<AgentRecord>("agent:");
      let id = `agent:${slug(name)}`;
      for (let i = 2; existing.has(id); i++) id = `agent:${slug(name)}-${i}`;
      await tx.put<AgentRecord>(id, { id, name: name.slice(0, 64), ...how, createdAt: this.d.clock.now() });
      const t = await this.targets(tx);
      t.agents = [...new Set([...t.agents, id])];
      await tx.put("targets", t);
      const w = how.workload;
      await this.audit(tx, { type: "agent", text: w ? `Trusted ${w.subject} from ${w.issuer} as agent ${id}.` : `Added agent ${id}.`, ref: id });
      return id;
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

  /** The agent a bearer token belongs to: one of okayed's agent tokens, or a trusted workload's identity token. */
  async agentFor(token: string | null | undefined): Promise<string | null> {
    if (!token) return null;
    const agents = [...(await this.d.store.list<AgentRecord>("agent:")).values()];
    const h = sha256Hex(token);
    for (const a of agents) if (a.tokenHash && a.tokenHash === h) return a.id;
    if (token.split(".").length !== 3) return null;
    const trusts: WorkloadTrust[] = agents.flatMap((a) => (a.workload ? [{ ...a.workload, agent: a.id }] : []));
    return trusts.length ? agentForWorkload(token, trusts, this.d.fetch) : null;
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

  async submitRequest(agentId: string, input: { act?: unknown; res?: unknown; why?: unknown; ttl?: unknown; ref?: unknown }): Promise<{ request: Request; status: RequestStatus | "approving"; cardId?: string; reason?: string }> {
    // A caller's own id for this request (a tool call id): asking twice returns the first request, not a second one.
    const ref = typeof input.ref === "string" && input.ref ? input.ref.slice(0, 128) : undefined;
    if (ref) {
      const existing = await this.byRef(agentId, ref);
      if (existing) {
        const card = existing.cardId ? await this.d.store.get<Card>(`card:${existing.cardId}`) : undefined;
        const status = existing.status === "pending" && card?.status === "confirming" ? "approving" : existing.status;
        return { request: existing.request, status, ...(existing.cardId ? { cardId: existing.cardId } : {}), ...(existing.reason ? { reason: existing.reason } : {}) };
      }
    }
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
      const usage = await this.usage(tx);
      const result = narrowGrant({ utterance: "", proposal: request, requests: [request], targets, policy, now, select: request.id, usage });
      const rec: RequestRecord = { request, status: "pending", ...(ref ? { ref } : {}) };
      if (ref) await tx.put(`ref:${agentId}:${ref}`, request.id);
      await this.audit(tx, { type: "request", text: describeRequestSentence(request), ref: request.id, event });
      if (result.kind !== "grant") {
        rec.status = "denied";
        rec.reason = result.kind === "refuse" ? result.reason : result.question;
        await tx.put(`req:${request.id}`, rec);
        await this.audit(tx, { type: "deny", text: `Refused ${request.id}: ${rec.reason}`, ref: request.id });
        return { rec, card: null as Card | null, auto: false };
      }
      const card = grantCard(`c_${this.d.random.hex(8)}`, result, "request", now);
      if (result.decision.spent) {
        card.topUp = result.decision.spent;
        card.notes.push(await this.statement(tx, result.decision.spent));
      }
      const auto = result.decision.verdict === "allow" && !meta.paused;
      if (auto) card.status = "confirming";
      rec.cardId = card.id;
      await tx.put(`req:${request.id}`, rec);
      await tx.put(`card:${card.id}`, card);
      return { rec, card, auto };
    });

    if (out.card) {
      await this.d.lifecycle.start(out.card.id, { userId: this.d.userId, proposalId: out.card.id, waitSeconds: request.exp - now, auto: out.auto });
      if (!out.auto) {
        await this.attachExplanation(out.card);
        await this.push(out.card, request.exp);
      }
    }
    const status = out.auto ? "approving" : out.rec.status;
    const reply: { request: Request; status: RequestStatus | "approving"; cardId?: string; reason?: string } = { request, status };
    if (out.card) reply.cardId = out.card.id;
    if (out.rec.reason) reply.reason = out.rec.reason;
    return reply;
  }

  /** A request by the caller's own ref, as `submitRequest` recorded it. */
  async requestByRef(agentId: string, ref: string): Promise<{ status: RequestStatus; reason?: string; grant?: NostrEvent; cardId?: string } | null> {
    const id = await this.d.store.get<string>(`ref:${agentId}:${ref}`);
    if (!id) return null;
    const st = await this.requestStatus(agentId, id);
    const rec = await this.d.store.get<RequestRecord>(`req:${id}`);
    return st ? { ...st, ...(rec?.cardId ? { cardId: rec.cardId } : {}) } : null;
  }

  private async byRef(agentId: string, ref: string): Promise<RequestRecord | null> {
    const id = await this.d.store.get<string>(`ref:${agentId}:${ref}`);
    return id ? ((await this.d.store.get<RequestRecord>(`req:${id}`)) ?? null) : null;
  }

  // ---------- passkeys ----------

  private async passkeys(tx: Pick<Store, "get"> = this.d.store): Promise<StoredPasskey[]> {
    return (await tx.get<StoredPasskey[]>("passkeys")) ?? [];
  }

  /** Options for the browser to create a passkey (Face ID, Touch ID…) for approving. */
  async passkeyOptions(rp: RelyingParty) {
    const options = await registrationOptions(rp, this.d.userId, await this.passkeys());
    await this.d.store.put("pk:register", { challenge: options.challenge, exp: this.d.clock.now() + 300 });
    return options;
  }

  async addPasskey(rp: RelyingParty, response: unknown, name = "Face ID"): Promise<{ id: string; name: string }> {
    const pending = await this.d.store.get<{ challenge: string; exp: number }>("pk:register");
    if (!pending || pending.exp <= this.d.clock.now()) throw new OkayedError(409, "the setup took too long; try again");
    let passkey: StoredPasskey;
    try {
      passkey = await verifyRegistration(rp, response, pending.challenge, name.slice(0, 40), this.d.clock.now());
    } catch (e) {
      throw new OkayedError(400, (e as Error).message);
    }
    await this.d.store.transaction(async (tx) => {
      await tx.delete("pk:register");
      await tx.put("passkeys", [...(await this.passkeys(tx)).filter((p) => p.id !== passkey.id), passkey]);
      await this.audit(tx, { type: "passkey", text: `Set up ${passkey.name} for approvals.` });
    });
    return { id: passkey.id, name: passkey.name };
  }

  async removePasskey(id: string): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      await tx.put("passkeys", (await this.passkeys(tx)).filter((p) => p.id !== id));
      await this.audit(tx, { type: "passkey", text: "Removed a passkey." });
    });
  }

  /** Options for approving one card with a passkey: the challenge is a hash of exactly what is being approved. */
  async approvalChallenge(cardId: string, rp: RelyingParty) {
    const card = await this.d.store.get<Card>(`card:${cardId}`);
    if (!card || card.status !== "open") throw new OkayedError(409, "this isn't waiting for an okay");
    const keys = (await this.passkeys()).filter((p) => p.rpID === rp.rpID);
    if (!keys.length) throw new OkayedError(412, "set up Face ID first");
    const binding = bindingFor(cardId, card.draft ?? card.rules ?? card.sentence, this.d.random.hex(8));
    await this.d.store.put(`pk:card:${cardId}`, { binding, exp: this.d.clock.now() + 300 });
    return approvalOptions(rp, binding, keys);
  }

  /** Confirms a card with a verified passkey assertion; the proof rides on the grant. */
  async confirmWithPasskey(cardId: string, rp: RelyingParty, response: unknown): Promise<Card> {
    const pending = await this.d.store.get<{ binding: ApprovalBinding; exp: number }>(`pk:card:${cardId}`);
    if (!pending || pending.exp <= this.d.clock.now()) throw new OkayedError(409, "the approval took too long; try again");
    const card = await this.d.store.get<Card>(`card:${cardId}`);
    if (!card || bindingFor(cardId, card.draft ?? card.rules ?? card.sentence, pending.binding.nonce).draft !== pending.binding.draft) {
      throw new OkayedError(409, "the request changed after you were asked");
    }
    let verified: Awaited<ReturnType<typeof verifyApproval>>;
    try {
      verified = await verifyApproval(rp, response, pending.binding, await this.passkeys());
    } catch (e) {
      throw new OkayedError(401, (e as Error).message);
    }
    await this.d.store.transaction(async (tx) => {
      await tx.delete(`pk:card:${cardId}`);
      await tx.put("passkeys", (await this.passkeys(tx)).map((p) => (p.id === verified.passkey.id ? { ...p, counter: verified.counter } : p)));
    });
    return this.confirm(cardId, "webauthn", verified.proof);
  }

  // ---------- approver apps on other devices ----------

  private async approvers(tx: Pick<Store, "get"> = this.d.store): Promise<PairedApprover[]> {
    return (await tx.get<PairedApprover[]>("approvers")) ?? [];
  }

  /** Pairs an approver app by its public key, so approvals can be pushed to it and answered from there. */
  async pairApprover(pubkey: unknown, name?: unknown, wake?: unknown): Promise<PairedApprover> {
    if (typeof pubkey !== "string" || !/^[0-9a-f]{64}$/.test(pubkey)) throw new OkayedError(400, "pubkey must be 64 hex characters");
    // https, or plain http to this machine for development.
    if (wake !== undefined && (typeof wake !== "string" || !/^(?:https:\/\/|http:\/\/(?:localhost|127\.0\.0\.1)[:/])[^\s]+$/.test(wake))) throw new OkayedError(400, "wake must be an https URL");
    const a: PairedApprover = { pubkey, name: typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : "Approver app", createdAt: this.d.clock.now() };
    if (typeof wake === "string") a.wake = wake;
    await this.d.store.transaction(async (tx) => {
      await tx.put("approvers", [...(await this.approvers(tx)).filter((x) => x.pubkey !== pubkey), a]);
      await this.audit(tx, { type: "approver", text: `Paired ${a.name} for approvals.` });
    });
    return a;
  }

  async unpairApprover(pubkey: string): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      await tx.put("approvers", (await this.approvers(tx)).filter((a) => a.pubkey !== pubkey));
      await this.audit(tx, { type: "approver", text: "Unpaired an approver app." });
    });
  }

  /** Puts an open card in the paired apps' inbox, bound to its exact draft, and wakes them. */
  private async push(card: Card, exp: number): Promise<void> {
    const approvers = await this.approvers();
    if (!approvers.length || card.status !== "open") return;
    const binding = bindingFor(card.id, card.draft ?? card.rules ?? card.sentence, this.d.random.hex(8));
    const item: PushedApproval = { v: 0, card: card.id, binding, sentence: card.sentence, exp };
    if (card.draft) Object.assign(item, { act: card.draft.act, res: card.draft.res, risk: card.draft.risk });
    await this.d.store.put(`ap:card:${card.id}`, item);
    for (const a of approvers) await this.d.notifier?.notify(a).catch(() => undefined);
  }

  /** What's waiting for one paired app. The app signs the request (NIP-98), so only it can read its inbox. */
  async inbox(auth: string | null, url: string): Promise<PushedApproval[]> {
    const now = this.d.clock.now();
    const who = readHttpAuth(auth, url, "GET", now);
    if (!who.ok) throw new OkayedError(401, who.reason);
    if (!(await this.approvers()).some((a) => a.pubkey === who.pubkey)) throw new OkayedError(403, "that approver isn't paired");
    const out: PushedApproval[] = [];
    for (const [, p] of await this.d.store.list<PushedApproval>("ap:card:")) {
      const card = await this.d.store.get<Card>(`card:${p.card}`);
      if (card?.status === "open" && p.exp > now) out.push(p);
    }
    return out;
  }

  /** An app's signed answer (kind 4845). Allowing confirms the card, with the event as the grant's proof. */
  async answer(e: unknown): Promise<Card> {
    const cardId = (e as { tags?: unknown })?.tags && Array.isArray((e as NostrEvent).tags) ? (e as NostrEvent).tags.find((t) => t[0] === "card")?.[1] : undefined;
    const pending = cardId ? await this.d.store.get<PushedApproval>(`ap:card:${cardId}`) : undefined;
    if (!cardId || !pending || pending.exp <= this.d.clock.now()) throw new OkayedError(409, "nothing is waiting for that approval");
    const card = await this.d.store.get<Card>(`card:${cardId}`);
    if (!card || card.status !== "open") throw new OkayedError(409, "this isn't waiting for an okay anymore");
    if (bindingFor(cardId, card.draft ?? card.rules ?? card.sentence, pending.binding.nonce).draft !== pending.binding.draft) throw new OkayedError(409, "the request changed after it was sent");
    const check = readAnswer(e, await this.approvers(), pending.binding);
    if (!check.ok) throw new OkayedError(401, check.reason);
    await this.d.store.delete(`ap:card:${cardId}`);
    return check.answer.verdict === "allow" ? this.confirm(cardId, "approver", { approver: check.approver.pubkey, event: e }) : this.deny(cardId);
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
      const card = chatCard(`c_${this.d.random.hex(8)}`, text, draft, { policy, targets, pending, now, usage: await this.usage(tx) });
      card.drafter = this.d.drafter.name;
      await tx.put(`card:${card.id}`, card);
      await this.say(tx, { role: "okayed", text: card.sentence, cardId: card.id });
      return card;
    });

    if (card.kind === "grant") {
      await this.d.lifecycle.start(card.id, { userId: this.d.userId, proposalId: card.id, waitSeconds: CHAT_CARD_WAIT, auto: false });
    }
    if (card.kind === "grant" || card.kind === "policy") {
      await this.attachExplanation(card);
      await this.push(card, now + CHAT_CARD_WAIT);
    }
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
        const layer = await this.layer(tx);
        const next: Layer = { ...layer, rules: [...layer.rules.filter((r) => r.until === undefined || r.until > now), ...(card.rules ?? [])] };
        await tx.put("layer", next);
        card.status = "confirmed";
        await tx.put(`card:${cardId}`, card);
        const event = await this.d.signer.sign(policyTemplate({ layers: [next] }, now));
        await this.audit(tx, { type: "policy", text: `Rules changed: ${(card.ruleTexts ?? []).join("; ")}.`, ref: cardId, event });
        return card;
      }
      if (card.kind !== "grant") throw new OkayedError(409, "nothing to confirm");
      card.status = "confirming";
      await tx.put(`card:${cardId}`, card);
      return card;
    });
    if (card.kind === "grant") {
      const a: { method: Exclude<Assurance["method"], "policy">; at: number; proof?: unknown } = { method: assurance === "policy" ? "web-click" : assurance, at: now };
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

  async revoke(grantId: string, reason = "taken back by you"): Promise<GrantRecord> {
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
      await this.audit(tx, { type: "revoke", text: `Taken back: ${sentenceFor(draftOf(rec.grant))} (${reason})`, ref: grantId, event });
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
      await this.audit(tx, { type: "stop", text: `Stopped everything: took back ${out.length} permission(s) and paused rules.`, event });
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
      await this.audit(tx, { type: "resume", text: "Rules resumed." });
    });
  }

  /** Replaces the person's rules wholesale, as an editor would. Each rule is checked; the posture is a fine reset. */
  async setRules(rules: unknown): Promise<Rule[]> {
    if (!Array.isArray(rules)) throw new OkayedError(400, "rules must be a list");
    const problems = rules.flatMap((r, i) => checkRule(r).map((p) => `rule ${i + 1}: ${p}`));
    if (problems.length) throw new OkayedError(400, problems.join("; "));
    const now = this.d.clock.now();
    const next = personalLayer(rules as Rule[]);
    const event = await this.d.signer.sign(policyTemplate({ layers: [next] }, now));
    await this.d.store.transaction(async (tx) => {
      await tx.put("layer", next);
      await this.audit(tx, { type: "policy", text: `Rules replaced: ${next.rules.length} rule(s).`, event });
    });
    return next.rules;
  }

  /** Replaces the shared budgets. None is a fine answer: budgets are opt-in. */
  async setBudgets(budgets: unknown): Promise<SharedBudget[]> {
    if (!Array.isArray(budgets)) throw new OkayedError(400, "budgets must be a list");
    const problems = budgets.flatMap((b, i) => checkBudget(b).map((p) => `budget ${i + 1}: ${p}`));
    if (problems.length) throw new OkayedError(400, problems.join("; "));
    const list = budgets as SharedBudget[];
    await this.d.store.transaction(async (tx) => {
      await tx.put("budgets", list);
      await this.audit(tx, { type: "policy", text: list.length ? `Limits set: ${list.map((b) => b.note ?? b.id).join(", ")}.` : "Limits removed." });
    });
    return list;
  }

  /** Resets what a budget has spent (a rule's id, or `budget:<id>`). One decision over everything it already did. */
  async topUp(key: string): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      const label = await this.budgetLabel(tx, key);
      if (!label) throw new OkayedError(404, "no budget with that id");
      const usage = await this.usage(tx);
      const before = usage[key] ?? { uses: 0, risk: 0 };
      delete usage[key];
      await tx.put("usage", usage);
      await this.audit(tx, { type: "policy", text: `Reset the limit on ${label} after ${before.uses} use(s), ${before.risk} points.`, ref: key });
    });
  }

  async removeRule(ruleId: string): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      const layer = await this.layer(tx);
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
    const ctx = { agent: draft.aud };
    // A policy approval names the policies it draws on; the transaction below re-checks them before charging.
    if (assurance.method === "policy") {
      const planned = decideAll(await this.policy(this.d.store), draft.act, draft.res, now, { ...ctx, usage: await this.usage(this.d.store) });
      assurance = { ...assurance, policy: planned.charges.map((c) => c.key) };
    }
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
      if (assurance.method === "policy" && meta.paused) return close("rules are paused after Stop everything");
      const usage = await this.usage(tx);
      const decision = decideAll(await this.policy(tx), draft.act, draft.res, now, { ...ctx, usage });
      if (decision.verdict === "deny") return close(decision.reason);
      // Auto-approvals draw on every budget that allowed them; your own okays draw only on pools that count them.
      let draws = decision.tallies;
      if (assurance.method === "policy") {
        if (decision.verdict !== "allow") return close("your rules no longer allow this");
        if (decision.charges.map((c) => c.key).join() !== (assurance.policy ?? []).join()) return close("the policies changed while this was being issued");
        draws = decision.charges;
      }
      for (const c of draws) {
        const u = usage[c.key] ?? { uses: 0, risk: 0 };
        usage[c.key] = { uses: u.uses + 1, risk: u.risk + c.cost };
      }
      if (draws.length) await tx.put("usage", usage);
      let req: RequestRecord | undefined;
      if (draft.from.request) {
        req = await tx.get<RequestRecord>(`req:${draft.from.request}`);
        if (!req || req.status !== "pending") return close("the request is no longer pending");
        if (req.request.exp <= now) return close("the request expired");
      }
      await tx.put<GrantRecord>(`grant:${grant.id}`, { grant, event, cardId, used: 0, status: "active", ...(draws.length ? { drew: draws.map((c) => c.key) } : {}) });
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
      const how = assurance.method === "policy" ? `allowed by your rules (${(assurance.policy ?? []).join(", ")})` : `allowed by you (${assurance.method})`;
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
    const snap = await buildSnapshot(s, who, await this.meta(s), await this.policy(s), await this.targets(s), await this.usage(s), this.d.clock.now());
    return { ...snap, passkeys: (await this.passkeys(s)).map(({ id, name, rpID, createdAt }) => ({ id, name, rpID, createdAt })), approvers: await this.approvers(s), packs: addedPacks() };
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
    const ceiling = await tx.get<Layer>("ceiling");
    const budgets = await this.budgets(tx);
    return { layers: [...(ceiling ? [ceiling] : []), await this.layer(tx)], ...(budgets.length ? { budgets } : {}) };
  }

  private async layer(tx: Pick<Store, "get">): Promise<Layer> {
    return (await tx.get<Layer>("layer")) ?? personalLayer();
  }

  private async usage(tx: Pick<Store, "get">): Promise<Usage> {
    return (await tx.get<Usage>("usage")) ?? {};
  }

  private async budgets(tx: Pick<Store, "get">): Promise<SharedBudget[]> {
    return (await tx.get<SharedBudget[]>("budgets")) ?? [];
  }

  /** "“merges go ahead…”" for a rule's budget, "the shared budget “this week”" for a pool; null if neither exists. */
  private async budgetLabel(tx: Pick<Store, "get">, key: string): Promise<string | null> {
    if (key.startsWith("budget:")) {
      const b = (await this.budgets(tx)).find((x) => `budget:${x.id}` === key);
      return b ? `the shared budget “${b.note ?? b.id}”` : null;
    }
    const rule = (await this.layer(tx)).rules.find((r) => r.id === key);
    return rule?.budget ? `“${describeRule(rule, this.d.clock.now())}”` : null;
  }

  /** What spent a budget: the last few grants that drew on it, so topping it up is one informed decision. */
  private async statement(tx: Pick<Store, "list" | "get">, key: string): Promise<string> {
    const spentBy = [...(await tx.list<GrantRecord>("grant:")).values()]
      .filter((g) => (g.drew ?? g.grant.assurance.policy ?? []).includes(key))
      .sort((a, b) => b.grant.nbf - a.grant.nbf);
    const u = (await this.usage(tx))[key] ?? { uses: 0, risk: 0 };
    const recent = spentBy.slice(0, 3).map((g) => g.grant.res.map((r) => labelRes(r).replace(/ at [0-9a-f]{7}$/, "")).join(" and "));
    const whose = key.startsWith("budget:") ? `The limit “${(await this.budgets(tx)).find((b) => `budget:${b.id}` === key)?.note ?? key.slice(7)}” is used up` : "Its limit is used up";
    return `${whose}: ${u.uses} use${u.uses === 1 ? "" : "s"}, ${u.risk} points${recent.length ? `, most recently ${recent.join("; ")}` : ""}. Reset it to let it continue.`;
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
      } else if (x.kind === "custom" && !(t.named ?? []).some((n) => n.res === s)) {
        // A registered pack's resource: remember it by the names people would use, so words can bind to it.
        t.named = [...(t.named ?? []), { res: s, names: namesFor(s, x) }].slice(-200);
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
