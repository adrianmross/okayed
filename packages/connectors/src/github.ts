import { formatRes, type Facts } from "@okayed/engine";
import type { Connector, CredentialSource } from "@okayed/core";

/**
 * GitHub: merge a pull request under a grant, pinned to the commit the grant names. The credential is a stored
 * fine-grained token, or (better) a GitHub App installation token minted for this one repository and revoked after.
 */

type Fetch = typeof fetch;
const API = "https://api.github.com";

function headers(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "okayed" };
}

/** Whether the commit's checks passed, for the `checks.pass` condition. Unknown (undefined) on any error. */
export async function checksPass(f: Fetch, token: string, owner: string, repo: string, sha: string): Promise<boolean | undefined> {
  try {
    const r = await f(`${API}/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`, { headers: headers(token) });
    if (!r.ok) return undefined;
    const body = (await r.json()) as { check_runs: { status: string; conclusion: string | null }[] };
    if (!body.check_runs.length) return undefined;
    return body.check_runs.every((c) => c.status === "completed" && ["success", "neutral", "skipped"].includes(c.conclusion ?? ""));
  } catch {
    return undefined;
  }
}

/** The PR's current head commit, from GitHub, so the binder never trusts an agent's word for it. */
export async function prHead(f: Fetch, token: string, owner: string, repo: string, number: number): Promise<string | undefined> {
  try {
    const r = await f(`${API}/repos/${owner}/${repo}/pulls/${number}`, { headers: headers(token) });
    if (!r.ok) return undefined;
    return ((await r.json()) as { head: { sha: string } }).head.sha;
  } catch {
    return undefined;
  }
}

export interface MergeInput {
  owner: string;
  repo: string;
  number: number;
  sha: string;
  method: "merge" | "squash" | "rebase";
}

/** POST /tools/github/merge: `{ grant, owner, repo, number, sha, method? }`. */
export function githubMerge(o: { credential: CredentialSource; fetch?: Fetch }): Connector<MergeInput> {
  const f = o.fetch ?? fetch;
  return {
    id: "github/merge",
    act: "github.pr.merge",
    title: "Merge a pull request on GitHub",
    credential: o.credential,
    input(b) {
      const { owner, repo, number, sha, method } = b as Partial<Record<keyof MergeInput, unknown>>;
      if (typeof owner !== "string" || typeof repo !== "string" || typeof number !== "number" || typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) {
        throw new Error("send owner, repo, number and the 40-character head sha");
      }
      return { owner, repo, number, sha: sha.toLowerCase(), method: method === "merge" || method === "rebase" ? method : "squash" };
    },
    resource: (i) => formatRes({ kind: "github.pr", owner: i.owner, repo: i.repo, number: i.number, sha: i.sha }),
    scope: (i) => ({ repo: i.repo, owner: i.owner }),
    async facts(i, token): Promise<Facts> {
      const pass = token ? await checksPass(f, token, i.owner, i.repo, i.sha) : undefined;
      return pass === undefined ? {} : { "checks.pass": pass };
    },
    async perform(i, { token }) {
      // `sha` makes GitHub refuse if the head moved since the grant pinned it.
      const r = await f(`${API}/repos/${i.owner}/${i.repo}/pulls/${i.number}/merge`, {
        method: "PUT",
        headers: { ...headers(token ?? ""), "content-type": "application/json" },
        body: JSON.stringify({ sha: i.sha, merge_method: i.method }),
      });
      const body = (await r.json().catch(() => ({}))) as { sha?: string; message?: string };
      if (!r.ok) throw new Error(body.message ?? `GitHub said ${r.status}`);
      return { merged: true, sha: body.sha };
    },
  };
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const b64url = (b: Uint8Array | string) => btoa(typeof b === "string" ? b : String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * A GitHub App installation token, minted per call for just the repository the call touches and just the
 * permissions given, then revoked. The App's private key (PKCS#8 PEM) never leaves okayed.
 */
export function githubAppCredential(o: { appId: string; privateKey: string; installationId: string; permissions: Record<string, "read" | "write">; fetch?: Fetch; now?: () => number }): CredentialSource {
  const f = o.fetch ?? fetch;
  return async (need) => {
    const now = Math.floor((o.now ?? (() => Date.now() / 1000))());
    const key = await crypto.subtle.importKey("pkcs8", pemToDer(o.privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: o.appId }))}`;
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
    const r = await f(`${API}/app/installations/${o.installationId}/access_tokens`, {
      method: "POST",
      headers: { ...headers(`${unsigned}.${b64url(sig)}`), "content-type": "application/json" },
      body: JSON.stringify({ ...(need.scope?.repo ? { repositories: [need.scope.repo] } : {}), permissions: o.permissions }),
    });
    const body = (await r.json().catch(() => ({}))) as { token?: string; message?: string };
    if (!r.ok || !body.token) throw new Error(`GitHub App token: ${body.message ?? `HTTP ${r.status}`}`);
    const token = body.token;
    return { token, release: async () => void (await f(`${API}/installation/token`, { method: "DELETE", headers: headers(token) })) };
  };
}
