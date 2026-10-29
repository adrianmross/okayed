import { DurableObject } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { ScimDirectory, applyDirectory, handleScim, personBySubject, readOrgPolicy, type OrgPolicy } from "@okayed/interop";
import { DurableStore } from "./adapters.ts";
import type { Env } from "./env.ts";

/** The organization's policy (ORG_POLICY), or, with none, one that only stops people the directory removes. */
export function orgPolicy(env: Env): OrgPolicy {
  return readOrgPolicy(env.ORG_POLICY) ?? { name: "your organization", default: "abstain", grants: [] };
}

/** The issuer people sign in with, whose subjects name their okayed: an OIDC provider, or Cloudflare Access. */
export function signInIssuer(env: Env): string | null {
  return env.OIDC_ISSUER ?? (env.ACCESS_TEAM ? `https://${env.ACCESS_TEAM}.cloudflareaccess.com` : null);
}

/**
 * The organization's directory: one Durable Object for the deployment, which its identity provider provisions over
 * SCIM. It's the single writer for who's in which group, and when someone changes, it reaches into their own
 * Durable Object (by name, signed in yet or not) to set their limits, or to stop everything their agents hold.
 */
export class OkayedDirectory extends DurableObject<Env> {
  private dir?: ScimDirectory;

  private directory(): ScimDirectory {
    if (this.dir) return this.dir;
    const issuer = signInIssuer(this.env);
    const subject = this.env.SCIM_SUBJECT === "userName" || this.env.SCIM_SUBJECT === "id" ? this.env.SCIM_SUBJECT : "externalId";
    const find = issuer ? personBySubject(issuer, subject) : async () => null;
    this.dir = new ScimDirectory(new DurableStore(this.ctx.storage), {
      onChange: applyDirectory(orgPolicy(this.env), {
        personFor: find,
        setLimits: async (userId, layer) => (await getAgentByName(this.env.OkayedAgent, userId)).setLimits("organization", layer),
        stop: async (userId, reason) => (await getAgentByName(this.env.OkayedAgent, userId)).orgStop(reason),
      }),
    });
    return this.dir;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    return handleScim(this.directory(), req, url.pathname.replace(/^\/scim\/v2/, ""), { token: this.env.SCIM_TOKEN ?? "", base: `${url.origin}/scim/v2` });
  }
}
