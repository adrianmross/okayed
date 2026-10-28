import { formatRes } from "@okayed/engine";
import type { Connector, CredentialSource } from "@okayed/core";

/**
 * Cloudflare: deploy a Pages project under a grant, with an account API token minted for each call. The standing
 * secret can only create tokens (Account API Tokens: Edit); each minted token carries just the permission groups the
 * connector needs, on just the resources it touches, and dies with the grant (ten minutes at most).
 */

type Fetch = typeof fetch;
const API = "https://api.cloudflare.com/client/v4";
const TOKEN_MAX = 10 * 60;

async function cf<T>(f: Fetch, method: string, path: string, token: string, body?: unknown): Promise<T> {
  const form = body instanceof FormData;
  const r = await f(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body && !form ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: form ? body : JSON.stringify(body) } : {}),
  });
  const json = (await r.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message: string }[] };
  if (!r.ok || json.success === false) throw new Error(`Cloudflare ${method} ${path.replace(/\/tokens\/[^/]+$/, "/tokens/…")}: ${json.errors?.[0]?.message ?? `HTTP ${r.status}`}`);
  return json.result as T;
}

export interface CloudflareTokenOptions {
  accountId: string;
  /** A token that can create and delete account API tokens, and nothing else. */
  token: string;
  /** Permission group names (e.g. "Pages Write", "DNS Write") or ids. */
  permissions: string[];
  /** Which resources the minted token covers; the whole account by default. `scope` comes from the connector. */
  resources?: (scope: Record<string, string> | undefined) => Record<string, string>;
  fetch?: Fetch;
  now?: () => number;
}

/** A just-in-time Cloudflare API token per call, deleted afterwards. */
export function cloudflareToken(o: CloudflareTokenOptions): CredentialSource {
  const f = o.fetch ?? fetch;
  let groups: Promise<string[]> | null = null;
  const groupIds = () =>
    (groups ??= (async () => {
      if (o.permissions.every((p) => /^[0-9a-f]{32}$/.test(p))) return o.permissions;
      const all = await cf<{ id: string; name: string }[]>(f, "GET", `/accounts/${o.accountId}/tokens/permission_groups`, o.token);
      return o.permissions.map((p) => {
        const g = all.find((x) => x.id === p || x.name === p);
        if (!g) throw new Error(`no Cloudflare permission group called ${p}`);
        return g.id;
      });
    })());
  return async (need) => {
    const now = Math.floor((o.now ?? (() => Date.now() / 1000))());
    const iso = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const child = await cf<{ id: string; value: string }>(f, "POST", `/accounts/${o.accountId}/tokens`, o.token, {
      name: `okayed ${new Date(now * 1000).toISOString()}`,
      policies: [{ effect: "allow", resources: o.resources?.(need.scope) ?? { [`com.cloudflare.api.account.${o.accountId}`]: "*" }, permission_groups: (await groupIds()).map((id) => ({ id })) }],
      not_before: iso(now - 5),
      expires_on: iso(Math.min(need.until, now + TOKEN_MAX)),
    });
    return { token: child.value, release: async () => void (await cf(f, "DELETE", `/accounts/${o.accountId}/tokens/${child.id}`, o.token)) };
  };
}

/** Which Pages project each site is, and which branch each environment deploys from. */
export type PagesSites = Record<string, { project: string; branches: Record<string, string> }>;

/** POST /tools/cloudflare/deploy: `{ grant, site, env }`. Deploys the branch an environment maps to. */
export function cloudflarePagesDeploy(o: { accountId: string; sites: PagesSites; credential: CredentialSource; fetch?: Fetch }): Connector<{ host: string; env: string; project: string; branch: string }> {
  const f = o.fetch ?? fetch;
  return {
    id: "cloudflare/deploy",
    act: "site.deploy",
    title: "Deploy a site on Cloudflare Pages",
    credential: o.credential,
    input(b) {
      const host = String(b.site ?? "");
      const env = String(b.env ?? "");
      const conf = o.sites[host];
      const branch = conf?.branches[env];
      if (!conf || !branch) throw new Error(`${host || "that site"} (${env || "?"}) isn't a Pages deployment okayed manages`);
      return { host, env, project: conf.project, branch };
    },
    resource: (i) => formatRes({ kind: "site", host: i.host, env: i.env }),
    async perform(i, { token }) {
      const form = new FormData();
      form.set("branch", i.branch);
      const d = await cf<{ id: string; url?: string }>(f, "POST", `/accounts/${o.accountId}/pages/projects/${encodeURIComponent(i.project)}/deployments`, token ?? "", form);
      return { deployed: true, id: d.id, ...(d.url ? { url: d.url } : {}) };
    },
  };
}
