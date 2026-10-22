import { canonRes, formatRes, parseRes, type Facts } from "@okayed/engine";
import type { OkayedService } from "./service.ts";
import type { Vault } from "./ports.ts";

/**
 * The demo tool: merge a PR on GitHub, but only under a live grant. The agent sends the grant and the target;
 * the token comes from the vault and never leaves this function.
 */

export interface MergeInput {
  grant: unknown;
  aud: string;
  owner: string;
  repo: string;
  number: number;
  sha: string;
  method?: "merge" | "squash" | "rebase";
}

export type MergeResult =
  | { ok: true; merged: true; sha: string; receipt?: unknown; left: number }
  | { ok: false; stage: "grant" | "github" | "config"; reason: string; status?: number };

type Fetch = typeof fetch;

const API = "https://api.github.com";

function headers(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "okayed" };
}

/** Looks up whether the commit's checks passed, for the `checks.pass` condition. Unknown on any error. */
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

export async function mergeWithGrant(svc: OkayedService, vault: Vault, input: MergeInput, f: Fetch = fetch): Promise<MergeResult> {
  const res = canonRes(formatRes({ kind: "github.pr", owner: input.owner, repo: input.repo, number: input.number, sha: input.sha }));
  if (!res || parseRes(res)?.kind !== "github.pr") return { ok: false, stage: "grant", reason: "not an exact PR at a commit" };
  const token = await vault.github();
  if (!token) return { ok: false, stage: "config", reason: "no GitHub credential is configured for the demo tool" };

  // Check first without spending the use, so a failed condition doesn't burn it.
  const facts: Facts = {};
  const pass = await checksPass(f, token, input.owner, input.repo, input.sha);
  if (pass !== undefined) facts["checks.pass"] = pass;
  const dry = await svc.verify({ event: input.grant, aud: input.aud, act: "github.pr.merge", res, consume: false, facts });
  if (!dry.ok) return { ok: false, stage: "grant", reason: dry.reason };

  const used = await svc.verify({ event: input.grant, aud: input.aud, act: "github.pr.merge", res, consume: true, facts });
  if (!used.ok) return { ok: false, stage: "grant", reason: used.reason };

  // `sha` makes GitHub refuse if the head moved since the grant pinned it.
  const r = await f(`${API}/repos/${input.owner}/${input.repo}/pulls/${input.number}/merge`, {
    method: "PUT",
    headers: { ...headers(token), "content-type": "application/json" },
    body: JSON.stringify({ sha: input.sha, merge_method: input.method ?? "squash" }),
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { message?: string };
    return { ok: false, stage: "github", status: r.status, reason: body.message ?? `GitHub said ${r.status}` };
  }
  const body = (await r.json()) as { sha: string };
  const out: MergeResult = { ok: true, merged: true, sha: body.sha, left: used.left };
  if (used.receipt) out.receipt = used.receipt;
  return out;
}
