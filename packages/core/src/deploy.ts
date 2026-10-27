import { canonRes, formatRes } from "@okayed/engine";
import type { OkayedService } from "./service.ts";

/**
 * Deploys a site environment for a live grant. The platform does the deploy with a credential okayed holds; the
 * agent only ever hands over the grant. Cloudflare's adapter mints a just-in-time API token per deploy.
 */
export interface Deployer {
  readonly name: string;
  /** Deploys `host`'s `env`, with any credential it makes living no longer than `until` (unix seconds). */
  deploy(site: { host: string; env: string }, until: number): Promise<{ id: string; url?: string }>;
}

export type DeployResult =
  | { ok: true; deployed: true; id: string; url?: string; left: number; receipt?: unknown }
  | { ok: false; stage: "grant" | "deploy"; reason: string };

export async function deployWithGrant(svc: OkayedService, deployer: Deployer, input: { grant: unknown; aud: string; host: string; env: string }): Promise<DeployResult> {
  const res = canonRes(formatRes({ kind: "site", host: input.host, env: input.env }));
  if (!res) return { ok: false, stage: "grant", reason: "not an exact site and environment" };
  // Spend the use first: once means once, even if the platform then fails.
  const used = await svc.verify({ event: input.grant, aud: input.aud, act: "site.deploy", res, consume: true });
  if (!used.ok) return { ok: false, stage: "grant", reason: used.reason };
  const exp = (input.grant as { content?: string })?.content ? (JSON.parse((input.grant as { content: string }).content) as { exp: number }).exp : 0;
  try {
    const d = await deployer.deploy({ host: input.host, env: input.env }, exp);
    const out: DeployResult = { ok: true, deployed: true, id: d.id, left: used.left };
    if (d.url) out.url = d.url;
    if (used.receipt) out.receipt = used.receipt;
    return out;
  } catch (e) {
    return { ok: false, stage: "deploy", reason: (e as Error).message };
  }
}
