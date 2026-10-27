import type { Deployer } from "@okayed/core";

/** Which Cloudflare Pages project each site is, and which branch each environment deploys from. */
export type PagesSites = Record<string, { project: string; branches: Record<string, string> }>;

export interface PagesDeployerOptions {
  accountId: string;
  /** A token that can create and delete account API tokens (Account API Tokens: Edit), and nothing else. */
  token: string;
  sites: PagesSites;
  /** The "Pages Write" permission group id; looked up by name when not given. */
  permissionGroup?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const API = "https://api.cloudflare.com/client/v4";
/** A just-in-time token never outlives this, even if the grant would. */
const TOKEN_MAX = 10 * 60;

/**
 * Real deploys on Cloudflare Pages. For each deploy okayed mints an account API token that can only write Pages,
 * valid from now until the grant expires (ten minutes at most), uses it for one deployment, and deletes it. The
 * long-lived token can only mint tokens, so a leak of either is small and short.
 */
export class CloudflarePagesDeployer implements Deployer {
  readonly name = "cloudflare-pages";
  private readonly o: PagesDeployerOptions;
  private readonly f: typeof fetch;

  constructor(o: PagesDeployerOptions) {
    this.o = o;
    this.f = o.fetch ?? fetch;
  }

  private async api<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
    const form = body instanceof FormData;
    const r = await this.f(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body && !form ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: form ? body : JSON.stringify(body) } : {}),
    });
    const json = (await r.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message: string }[] };
    if (!r.ok || json.success === false) throw new Error(`Cloudflare ${method} ${path.replace(/\/tokens\/[^/]+$/, "/tokens/…")}: ${json.errors?.[0]?.message ?? `HTTP ${r.status}`}`);
    return json.result as T;
  }

  private async pagesWrite(): Promise<string> {
    if (this.o.permissionGroup) return this.o.permissionGroup;
    const groups = await this.api<{ id: string; name: string }[]>("GET", `/accounts/${this.o.accountId}/tokens/permission_groups`, this.o.token);
    const g = groups.find((x) => x.name === "Pages Write");
    if (!g) throw new Error("couldn't find the Pages Write permission group");
    return g.id;
  }

  async deploy(site: { host: string; env: string }, until: number): Promise<{ id: string; url?: string }> {
    const conf = this.o.sites[site.host];
    const branch = conf?.branches[site.env];
    if (!conf || !branch) throw new Error(`${site.host} (${site.env}) isn't a Pages deployment okayed manages`);
    const now = Math.floor((this.o.now ?? (() => Date.now() / 1000))());
    const iso = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const child = await this.api<{ id: string; value: string }>("POST", `/accounts/${this.o.accountId}/tokens`, this.o.token, {
      name: `okayed: deploy ${site.host} ${site.env}`,
      policies: [{ effect: "allow", resources: { [`com.cloudflare.api.account.${this.o.accountId}`]: "*" }, permission_groups: [{ id: await this.pagesWrite() }] }],
      not_before: iso(now - 5),
      expires_on: iso(Math.min(until, now + TOKEN_MAX)),
    });
    try {
      const form = new FormData();
      form.set("branch", branch);
      const d = await this.api<{ id: string; url?: string }>("POST", `/accounts/${this.o.accountId}/pages/projects/${encodeURIComponent(conf.project)}/deployments`, child.value, form);
      return { id: d.id, ...(d.url ? { url: d.url } : {}) };
    } finally {
      await this.api("DELETE", `/accounts/${this.o.accountId}/tokens/${child.id}`, this.o.token).catch(() => undefined);
    }
  }
}
