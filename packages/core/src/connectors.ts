import { canonRes, type Facts } from "@okayed/engine";
import { openGrantEvent, type Grant, type NostrEvent } from "@okayed/grant";
import type { OkayedService } from "./service.ts";

/**
 * Connectors: what okayed does for an agent once a grant allows it, on any service. The agent hands over the grant
 * and the target; the connector gets a credential, does the one thing, and never shows the credential to anyone.
 * Implementations live in @okayed/connectors (GitHub, Cloudflare, Slack…) or in your own code.
 */

/** A credential for one call. A minted one is released (revoked) as soon as the call is done. */
export interface Credential {
  token: string;
  release?: () => Promise<void>;
}

/**
 * Where a connector gets its credential: a stored secret, or one minted for this call and no longer than the grant
 * lives (`until`), narrowed to what the call touches (`scope`, e.g. the one repository).
 */
export type CredentialSource = (need: { until: number; scope?: Record<string, string> }) => Promise<Credential>;

/** A secret okayed holds, such as a fine-grained token. */
export function staticCredential(token: string | (() => string | null | undefined)): CredentialSource {
  return async () => {
    const t = typeof token === "function" ? token() : token;
    if (!t) throw new Error("no credential is configured for this connector");
    return { token: t };
  };
}

export interface Connector<I = Record<string, unknown>> {
  /** Its route: POST /tools/<id>, e.g. "github/merge". */
  readonly id: string;
  /** The action it performs, as the engine names it. */
  readonly act: string;
  readonly title: string;
  /** Reads the call's input; throws a message the agent can act on when it's malformed. */
  input(body: Record<string, unknown>): I;
  /** The exact resource this call acts on. The grant must name it. */
  resource(input: I): string;
  /** What the credential needs to cover for this call, for sources that mint narrowly. */
  scope?(input: I): Record<string, string>;
  credential?: CredentialSource;
  /** Facts the grant's conditions need, looked up before the use is spent (e.g. `checks.pass`). */
  facts?(input: I, token: string | null): Promise<Facts>;
  /** Does it. Returns what the agent should know. */
  perform(input: I, ctx: { token: string | null; grant: Grant }): Promise<Record<string, unknown>>;
}

export type ConnectorResult = ({ ok: true; left: number; receipt?: NostrEvent } & Record<string, unknown>) | { ok: false; stage: "input" | "grant" | "credential" | "action"; reason: string };

/**
 * The one way every connector acts: check the grant without spending it (with whatever facts its conditions need),
 * spend one use, act, and release the credential. A failed condition never burns a use.
 */
export async function performWithGrant<I>(svc: OkayedService, c: Connector<I>, body: Record<string, unknown>, aud: string, now = Date.now() / 1000): Promise<ConnectorResult> {
  let input: I;
  let res: string | null;
  try {
    input = c.input(body);
    res = canonRes(c.resource(input));
  } catch (e) {
    return { ok: false, stage: "input", reason: (e as Error).message };
  }
  if (!res) return { ok: false, stage: "input", reason: "that isn't an exact resource" };
  const opened = openGrantEvent(body.grant);
  if (!opened.ok) return { ok: false, stage: "grant", reason: opened.reason };

  let cred: Credential | null = null;
  try {
    if (c.credential) {
      try {
        cred = await c.credential({ until: Math.min(opened.grant.exp, Math.floor(now) + 600), ...(c.scope ? { scope: c.scope(input) } : {}) });
      } catch (e) {
        return { ok: false, stage: "credential", reason: (e as Error).message };
      }
    }
    const token = cred?.token ?? null;
    const facts = c.facts ? await c.facts(input, token) : {};
    const dry = await svc.verify({ event: body.grant, aud, act: c.act, res, consume: false, facts });
    if (!dry.ok) return { ok: false, stage: "grant", reason: dry.reason };
    const used = await svc.verify({ event: body.grant, aud, act: c.act, res, consume: true, facts });
    if (!used.ok) return { ok: false, stage: "grant", reason: used.reason };
    try {
      const out = await c.perform(input, { token, grant: opened.grant });
      return { ...out, ok: true, left: used.left, ...(used.receipt ? { receipt: used.receipt } : {}) };
    } catch (e) {
      return { ok: false, stage: "action", reason: (e as Error).message };
    }
  } finally {
    await cred?.release?.().catch(() => undefined);
  }
}
