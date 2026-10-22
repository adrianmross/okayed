export type Resource =
  | { kind: "github.repo"; owner: string; repo: string }
  | { kind: "github.pr"; owner: string; repo: string; number: number; sha?: string }
  | { kind: "site"; host: string; env: string }
  | { kind: "money"; account: string; currency: string; max: number };

const NAME = "[a-z0-9][a-z0-9._-]*";
const RE_REPO = new RegExp(`^github:(${NAME})/(${NAME})$`);
const RE_PR = new RegExp(`^github:(${NAME})/(${NAME})/pull/([1-9][0-9]{0,8})(?:@([0-9a-f]{40}))?$`);
const RE_SITE = new RegExp(`^site:(${NAME}(?:\\.${NAME})*)/(${NAME})$`);
const RE_MONEY = new RegExp(`^money:(${NAME})/([A-Z]{3})/([0-9]+(?:\\.[0-9]{1,2})?)$`);

/** True if the string uses pattern syntax. Grants never may. */
export function isPattern(s: string): boolean {
  return s.includes("*");
}

/**
 * Parses an exact resource. Owner, repo and host are case-insensitive and normalized to lowercase;
 * anything that doesn't fit the grammar exactly returns null.
 */
export function parseRes(input: string): Resource | null {
  if (typeof input !== "string" || isPattern(input) || input.length > 300) return null;
  const money = RE_MONEY.exec(input);
  if (money) return { kind: "money", account: money[1]!, currency: money[2]!, max: Number(money[3]) };
  const s = input.toLowerCase();
  let m = RE_PR.exec(s);
  if (m) {
    const r: Resource = { kind: "github.pr", owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
    if (m[4]) r.sha = m[4];
    return r;
  }
  if ((m = RE_REPO.exec(s))) return { kind: "github.repo", owner: m[1]!, repo: m[2]! };
  if ((m = RE_SITE.exec(s))) return { kind: "site", host: m[1]!, env: m[2]! };
  return null;
}

export function formatRes(r: Resource): string {
  switch (r.kind) {
    case "github.repo":
      return `github:${r.owner}/${r.repo}`;
    case "github.pr":
      return `github:${r.owner}/${r.repo}/pull/${r.number}${r.sha ? `@${r.sha}` : ""}`;
    case "site":
      return `site:${r.host}/${r.env}`;
    case "money":
      return `money:${r.account}/${r.currency}/${r.max}`;
  }
}

/** Canonical spelling of an exact resource, or null. */
export function canonRes(s: string): string | null {
  const r = parseRes(s);
  return r ? formatRes(r) : null;
}

/** `owner/repo` of a GitHub resource. */
export function repoOf(r: Resource): string | null {
  return r.kind === "github.repo" || r.kind === "github.pr" ? `${r.owner}/${r.repo}` : null;
}

function escape(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches an exact resource against a pattern: `*` is one segment (no `/` or `@`), `**` is the rest.
 * Comparison is case-insensitive for GitHub and sites, as in `parseRes`.
 */
export function matchRes(pattern: string | undefined, res: string): boolean {
  if (pattern === undefined || pattern === "**" || pattern === "*") return true;
  const canon = canonRes(res);
  if (!canon) return false;
  const p = pattern.startsWith("money:") ? pattern : pattern.toLowerCase();
  const re = escape(p)
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/@]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`).test(canon);
}

/** Matches an action against a pattern where `*` matches any run of characters. */
export function matchAct(pattern: string, act: string): boolean {
  const re = escape(pattern).replace(/\*/g, ".*");
  return new RegExp(`^${re}$`).test(act);
}

/** A short human label: "PR #182 in adrianmross/okayed at 3f9a1c2". */
export function labelRes(s: string): string {
  const r = parseRes(s);
  if (!r) return s;
  switch (r.kind) {
    case "github.repo":
      return `${r.owner}/${r.repo}`;
    case "github.pr":
      return `PR #${r.number} in ${r.owner}/${r.repo}${r.sha ? ` at ${r.sha.slice(0, 7)}` : ""}`;
    case "site":
      return `${r.host} (${r.env})`;
    case "money":
      return `up to ${r.max} ${r.currency} from ${r.account}`;
  }
}
