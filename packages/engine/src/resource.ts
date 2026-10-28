export type Resource =
  | { kind: "github.repo"; owner: string; repo: string }
  | { kind: "github.pr"; owner: string; repo: string; number: number; sha?: string }
  | { kind: "site"; host: string; env: string }
  | { kind: "money"; account: string; currency: string; max: number }
  /** A resource of a registered type (`registerPack`), e.g. `slack:acme/releases` of type `slack.channel`. */
  | { kind: "custom"; type: string; fields: Record<string, string> };

/**
 * A resource type, declared as data. Each `{field}` in the template is one value (a lowercase name by default, or
 * the regex in `fields`), so parsing, the canonical spelling, labels and patterns all follow from it:
 * `slack:{workspace}/{channel}`, read as `#{channel} in {workspace}`.
 */
export interface ResourceType {
  /** The kind actions list in `res`, e.g. `slack.channel`. */
  kind: string;
  /** `<scheme>:` then literal text and `{field}`s, e.g. `slack:{workspace}/{channel}`. */
  template: string;
  /** How people read one, e.g. `#{channel} in {workspace}`; `{field|upper}` uppercases a value. Defaults to the resource. */
  label?: string;
  /** A regex source per field, for values that aren't plain names, e.g. an email address. No anchors. */
  fields?: Record<string, string>;
  /** Keep case as written. Resources are otherwise case-insensitive and stored lowercase. */
  caseSensitive?: boolean;
  /** The standing pattern "Always allow…" makes from one resource, e.g. `s3:{bucket}/**`. Defaults to the resource. */
  ruleScope?: string;
}

/** The built-in kinds, parsed by hand before any registered type. */
export const BUILTIN_KINDS: ReadonlySet<string> = new Set(["github.repo", "github.pr", "site", "money"]);
const BUILTIN_SCHEMES = new Set(["github", "site", "money"]);

const NAME = "[a-z0-9][a-z0-9._-]*";
const RE_REPO = new RegExp(`^github:(${NAME})/(${NAME})$`);
const RE_PR = new RegExp(`^github:(${NAME})/(${NAME})/pull/([1-9][0-9]{0,8})(?:@([0-9a-f]{40}))?$`);
const RE_SITE = new RegExp(`^site:(${NAME}(?:\\.${NAME})*)/(${NAME})$`);
const RE_MONEY = new RegExp(`^money:(${NAME})/([A-Z]{3})/([0-9]+(?:\\.[0-9]{1,2})?)$`);
const RE_SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const FIELD = /\{([a-z][a-zA-Z0-9]*)(\|upper)?\}/g;

interface Compiled {
  type: ResourceType;
  scheme: string;
  re: RegExp;
}

const TYPES = new Map<string, Compiled>();

function escape(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Checks and compiles a resource type; throws with the reason when it can't be used. */
export function compileResourceType(t: ResourceType): Compiled {
  if (!t || typeof t.kind !== "string" || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(t.kind)) {
    throw new Error(`resource kind "${t?.kind}" must be dotted lowercase, e.g. slack.channel`);
  }
  const m = /^([a-z][a-z0-9+.-]*):(.+)$/.exec(typeof t.template === "string" ? t.template : "");
  if (!m) throw new Error(`${t.kind}: template "${t.template}" must start with a scheme, e.g. slack:{workspace}/{channel}`);
  const scheme = m[1]!;
  const body = m[2]!;
  if (BUILTIN_SCHEMES.has(scheme)) throw new Error(`${t.kind}: the ${scheme}: scheme is built in`);
  if (body.includes("*")) throw new Error(`${t.kind}: a template names exact resources, so no wildcards`);
  const fields: string[] = [];
  let re = "";
  let last = 0;
  for (const f of body.matchAll(/\{([a-z][a-zA-Z0-9]*)\}/g)) {
    const name = f[1]!;
    if (fields.includes(name)) throw new Error(`${t.kind}: {${name}} appears twice in the template`);
    fields.push(name);
    const pattern = t.fields?.[name] ?? (t.caseSensitive ? "[A-Za-z0-9][A-Za-z0-9._-]*" : NAME);
    const literal = body.slice(last, f.index);
    if (/[{}]/.test(literal)) throw new Error(`${t.kind}: template "${t.template}" has a malformed {field}`);
    re += `${escape(literal)}(?<${name}>${pattern})`;
    last = f.index + f[0].length;
  }
  const tail = body.slice(last);
  if (/[{}]/.test(tail)) throw new Error(`${t.kind}: template "${t.template}" has a malformed {field}`);
  if (!fields.length) throw new Error(`${t.kind}: template "${t.template}" has no {fields}`);
  for (const f of Object.keys(t.fields ?? {})) if (!fields.includes(f)) throw new Error(`${t.kind}: fields.${f} isn't in the template`);
  for (const [what, text] of [["label", t.label], ["ruleScope", t.ruleScope]] as const) {
    for (const f of (text ?? "").matchAll(FIELD)) if (!fields.includes(f[1]!)) throw new Error(`${t.kind}: ${what} names {${f[1]}}, which isn't in the template`);
  }
  if (t.ruleScope !== undefined && !t.ruleScope.startsWith(`${scheme}:`)) throw new Error(`${t.kind}: ruleScope must use the ${scheme}: scheme`);
  try {
    return { type: t, scheme, re: new RegExp(`^${escape(scheme)}:${re}${escape(tail)}$`) };
  } catch (e) {
    throw new Error(`${t.kind}: a field pattern isn't a valid regex (${(e as Error).message})`);
  }
}

/** Adds resource types, all or none. */
export function registerResourceTypes(types: ResourceType[]): void {
  const compiled = types.map(compileResourceType);
  const kinds = compiled.map((c) => c.type.kind);
  if (new Set(kinds).size !== kinds.length) throw new Error("a resource kind appears twice");
  for (const k of kinds) if (BUILTIN_KINDS.has(k) || TYPES.has(k)) throw new Error(`resource kind ${k} is already registered`);
  for (const c of compiled) TYPES.set(c.type.kind, c);
}

export function unregisterResourceTypes(kinds: string[]): void {
  for (const k of kinds) TYPES.delete(k);
}

/** A registered resource type, by kind. */
export function resourceType(kind: string): ResourceType | undefined {
  return TYPES.get(kind)?.type;
}

/** The kind of a parsed resource, built-in or registered. */
export function kindOf(r: Resource): string {
  return r.kind === "custom" ? r.type : r.kind;
}

function caseSensitive(scheme: string): boolean {
  return scheme === "money" || [...TYPES.values()].some((c) => c.scheme === scheme && c.type.caseSensitive);
}

function fill(template: string, fields: Record<string, string>): string {
  return template.replace(FIELD, (_all, name: string, upper?: string) => (upper ? (fields[name] ?? "").toUpperCase() : (fields[name] ?? "")));
}

/** True if the string uses pattern syntax. Grants never may. */
export function isPattern(s: string): boolean {
  return s.includes("*");
}

/**
 * Parses an exact resource. Built-in kinds first (owner, repo and host are case-insensitive and normalized to
 * lowercase), then registered types by scheme. Anything that doesn't fit a grammar exactly returns null.
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
  const scheme = RE_SCHEME.exec(s)?.[1];
  if (!scheme || BUILTIN_SCHEMES.has(scheme)) return null;
  for (const c of TYPES.values()) {
    if (c.scheme !== scheme) continue;
    const x = c.re.exec(c.type.caseSensitive ? input : s);
    if (x?.groups) return { kind: "custom", type: c.type.kind, fields: { ...x.groups } };
  }
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
    case "custom":
      return fill(TYPES.get(r.type)?.type.template ?? "", r.fields);
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

/**
 * Matches an exact resource against a pattern: `*` is one segment (no `/` or `@`), `**` is the rest.
 * Comparison is case-insensitive, as in `parseRes`, except for money and case-sensitive registered types.
 */
export function matchRes(pattern: string | undefined, res: string): boolean {
  if (pattern === undefined || pattern === "**" || pattern === "*") return true;
  const canon = canonRes(res);
  if (!canon) return false;
  const p = caseSensitive(RE_SCHEME.exec(pattern)?.[1]?.toLowerCase() ?? "") ? pattern : pattern.toLowerCase();
  // "x/**" means x and everything under it, so "github:o/matrix/**" covers the repo itself too.
  if (p.endsWith("/**") && canon === p.slice(0, -3)) return true;
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

/** A short human label: "PR #182 in adrianmross/okayed at 3f9a1c2", "#releases in acme". */
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
    case "custom": {
      const label = TYPES.get(r.type)?.type.label;
      return label ? fill(label, r.fields) : formatRes(r);
    }
  }
}

/** The standing pattern "Always allow…" makes from one exact resource of a registered type, or null. */
export function ruleScopeOf(res: string): string | null {
  const r = parseRes(res);
  if (r?.kind !== "custom") return null;
  const scope = TYPES.get(r.type)?.type.ruleScope;
  return scope ? fill(scope, r.fields) : formatRes(r);
}
