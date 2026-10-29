import { OkayedError } from "@okayed/core";
import { CATALOG, canonRes, fitsAction } from "@okayed/engine";
import type { Grant } from "@okayed/grant";

/**
 * OAuth 2.0 Rich Authorization Requests (RFC 9396): `authorization_details`, the standard way to ask an
 * authorization server for something finer than a scope. okayed reads them as requests, and writes a grant as them,
 * so an authorization server can mint an access token that says exactly what was okayed.
 */
export interface AuthorizationDetail {
  type: string;
  locations?: string[];
  actions?: string[];
  datatypes?: string[];
  identifier?: string;
  privileges?: string[];
  [field: string]: unknown;
}

/** okayed's own type: one action on one exact resource, the `identifier`. */
export const OKAYED_DETAIL = "okayed";

/** A grant as `authorization_details`: one per resource, each carrying the grant's id, issuer, expiry and uses. */
export function detailsForGrant(g: Pick<Grant, "id" | "iss" | "act" | "res" | "exp" | "uses" | "when">, o: { type?: string; location?: string } = {}): AuthorizationDetail[] {
  return g.res.map((r) => ({
    type: o.type ?? OKAYED_DETAIL,
    actions: [g.act],
    identifier: r,
    ...(o.location ? { locations: [o.location] } : {}),
    okayed: { grant: g.id, iss: g.iss, exp: g.exp, uses: g.uses, ...(g.when.length ? { when: g.when } : {}) },
  }));
}

/** Reads one detail of a type it knows as an action on resources, or returns null to leave it to another reader. */
export type DetailReader = (d: AuthorizationDetail) => { act: string; res: string[] } | null;

/** okayed's own type. */
export const readOkayedDetail: DetailReader = (d) =>
  d.type === OKAYED_DETAIL && d.actions?.length === 1 && typeof d.actions[0] === "string" && typeof d.identifier === "string" ? { act: d.actions[0], res: [d.identifier] } : null;

/**
 * RFC 9396's own example, `payment_initiation`, read as spending up to its amount from one of the person's accounts:
 * `{ instructedAmount: { currency: "EUR", amount: "123.50" } }` is `money:<account>/EUR/123.50`.
 */
export function paymentInitiation(o: { account: string }): DetailReader {
  return (d) => {
    if (d.type !== "payment_initiation") return null;
    const amt = d.instructedAmount as { currency?: unknown; amount?: unknown } | undefined;
    const currency = typeof amt?.currency === "string" ? amt.currency.toUpperCase() : "";
    const amount = typeof amt?.amount === "string" || typeof amt?.amount === "number" ? String(amt.amount) : "";
    if (!/^[A-Z]{3}$/.test(currency) || !/^[0-9]+(\.[0-9]{1,2})?$/.test(amount)) return null;
    return { act: "spend.money", res: [`money:${o.account}/${currency}/${amount}`] };
  };
}

/**
 * `authorization_details` as okayed requests: one per action, with every resource for it. Every resource must be
 * exact and fit its action, and a detail no reader understands is refused, never skipped: skipping would okay less
 * than was asked and look like more.
 */
export function requestsFromDetails(details: unknown, readers: DetailReader[] = [readOkayedDetail]): { act: string; res: string[] }[] {
  if (!Array.isArray(details) || !details.length) throw new Error("authorization_details must be a non-empty list");
  const byAct = new Map<string, string[]>();
  details.forEach((d, i) => {
    if (!d || typeof d !== "object" || typeof (d as AuthorizationDetail).type !== "string") throw new Error(`authorization_details[${i}] needs a type`);
    const read = readers.map((r) => r(d as AuthorizationDetail)).find(Boolean);
    if (!read) throw new Error(`authorization_details[${i}]: no reader for type "${(d as AuthorizationDetail).type}"`);
    if (!CATALOG[read.act]) throw new Error(`authorization_details[${i}]: unknown action "${read.act}"`);
    const list = byAct.get(read.act) ?? [];
    for (const r of read.res) {
      const c = canonRes(r);
      if (!c || !fitsAction(read.act, c)) throw new Error(`authorization_details[${i}]: "${r}" is not an exact resource for ${read.act}`);
      if (!list.includes(c)) list.push(c);
    }
    byAct.set(read.act, list);
  });
  return [...byAct].map(([act, res]) => ({ act, res }));
}

/**
 * okayed's HTTP API reading requests written as `authorization_details` (its `readRequest` hook). One request asks
 * for one action; details for several actions are refused with a reason.
 */
export function readRichRequests(readers?: DetailReader[]): (body: Record<string, unknown>) => Record<string, unknown> {
  return (body) => {
    if (body.authorization_details === undefined) return body;
    let reqs: { act: string; res: string[] }[];
    try {
      reqs = requestsFromDetails(body.authorization_details, readers);
    } catch (e) {
      throw new OkayedError(400, (e as Error).message);
    }
    if (reqs.length !== 1) throw new OkayedError(400, `one request asks for one action; these ask for ${reqs.map((r) => r.act).join(" and ")}`);
    const { authorization_details: _d, ...rest } = body;
    return { ...rest, act: reqs[0]!.act, res: reqs[0]!.res };
  };
}
