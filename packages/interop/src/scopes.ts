import { CATALOG, canonRes, matchAct, matchRes, type Layer, type Rule } from "@okayed/engine";

/**
 * OAuth scopes in okayed's terms. A scope is coarse ("repo", "chat:write") or carries a value ("deploy:staging"); a
 * `ScopeDef` says which okayed actions on which resources it covers, so a token's scopes can bound what an agent may
 * even ask for, and a grant can say which scopes a downscoped credential for it needs.
 */
export interface ScopeDef {
  /** The scope as issued, with `{field}`s for the values it carries: `deploy:{env}`, `files:read:{bucket}`. */
  scope: string;
  /** What it covers; `{field}`s from the scope fill in the resource patterns. */
  allows: { act: string; res?: string }[];
}

const FIELD = /\{([a-z][a-zA-Z0-9]*)\}/g;
/** A value a scope carries: one plain name, never a pattern or a path, so a scope can't widen what it names. */
const VALUE = "[a-z0-9][a-z0-9._-]*";

function escape(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** The values a granted scope carries for a def, or null when it isn't that def. */
function readScope(def: ScopeDef, granted: string): Record<string, string> | null {
  const names: string[] = [];
  const re = escape(def.scope).replace(/\\\{([a-z][a-zA-Z0-9]*)\\\}/g, (_m, n: string) => (names.push(n), `(${VALUE})`));
  const m = new RegExp(`^${re}$`).exec(granted);
  return m ? Object.fromEntries(names.map((n, i) => [n, m[i + 1]!])) : null;
}

const fill = (template: string, values: Record<string, string>) => template.replace(FIELD, (_m, n: string) => values[n] ?? "*");

/**
 * What a token's scopes let an agent do, as rules: each scope that has a def becomes one rule per thing it covers.
 * `effect` is `allow` by default: the scopes allow it, and the person's own rules still decide.
 */
export function rulesForScopes(granted: string | string[], defs: ScopeDef[], o: { effect?: "allow" | "ask"; agent?: string } = {}): Rule[] {
  const list = typeof granted === "string" ? granted.split(" ").filter(Boolean) : granted;
  const out: Rule[] = [];
  for (const s of new Set(list)) {
    for (const def of defs) {
      const values = readScope(def, s);
      if (!values) continue;
      def.allows.forEach((a, i) => {
        out.push({ id: `scope:${s}${def.allows.length > 1 ? `#${i + 1}` : ""}`, effect: o.effect ?? "allow", act: a.act, ...(a.res ? { res: fill(a.res, values) } : {}), ...(o.agent ? { agent: o.agent } : {}), note: `the token's ${s} scope` });
      });
    }
  }
  return out;
}

/**
 * A token's scopes as a limit above the person's rules: what they cover is left to the person, and everything else
 * is blocked. With `agent`, only that agent is limited (anyone else's requests aren't this layer's business).
 */
export function scopeCeiling(granted: string | string[], defs: ScopeDef[], o: { agent?: string; name?: string } = {}): Layer {
  const rules = rulesForScopes(granted, defs, o.agent ? { agent: o.agent } : {});
  const name = o.name ?? "the token's scopes";
  if (!o.agent) return { name, default: "deny", rules };
  return { name, default: "abstain", rules: [...rules, { id: "scope:else", effect: "deny", act: "*", agent: o.agent, note: "no scope the token carries covers it" }] };
}

/** How specific a resource pattern is: its literal characters, the way the engine ranks rules. */
const literal = (p: string | undefined) => (p ?? "").replace(FIELD, "").replace(/\*/g, "").length;

/**
 * The scopes that cover one action on one exact resource, narrowest first: what to ask an authorization server for
 * when minting a credential for a grant, and nothing more.
 */
export function scopesFor(act: string, res: string, defs: ScopeDef[]): string[] {
  const canon = canonRes(res);
  if (!canon) return [];
  const found: { scope: string; rank: number }[] = [];
  for (const def of defs) {
    for (const a of def.allows) {
      if (!matchAct(a.act, act)) continue;
      const names = [...def.scope.matchAll(FIELD)].map((m) => m[1]!);
      if (!a.res) {
        if (!names.length) found.push({ scope: def.scope, rank: 0 });
        continue;
      }
      if (!matchRes(a.res.replace(FIELD, "*"), canon)) continue;
      const captured: string[] = [];
      const re = escape(a.res)
        .replace(/\\\{([a-z][a-zA-Z0-9]*)\\\}/g, (_m, n: string) => (captured.push(n), `(${VALUE})`))
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/@]*")
        .replace(/\u0000/g, ".*");
      const m = new RegExp(`^${re}$`).exec(canon);
      if (!m) continue;
      const values = Object.fromEntries(captured.map((n, i) => [n, m[i + 1]!]));
      if (names.some((n) => values[n] === undefined)) continue;
      found.push({ scope: def.scope.replace(FIELD, (_x, n: string) => values[n]!), rank: literal(a.res) + names.length * 1000 });
    }
  }
  return [...new Map(found.sort((x, y) => y.rank - x.rank).map((f) => [f.scope, f])).keys()];
}

/** okayed's own actions as scopes: `github.read`, `site.deploy`, and each pack's `github.*`. */
export function actionScopes(): ScopeDef[] {
  const acts = Object.keys(CATALOG);
  const packs = [...new Set(acts.map((a) => a.split(".")[0]!))];
  return [...acts.map((act) => ({ scope: act, allows: [{ act }] })), ...packs.map((p) => ({ scope: `${p}.*`, allows: [{ act: `${p}.*` }] }))];
}

/**
 * GitHub OAuth app scopes (docs.github.com, "Scopes for OAuth apps"). Only `repo` covers what okayed's GitHub actions
 * do; `public_repo` is left out because a resource doesn't say whether its repo is public. GitHub App and
 * fine-grained tokens use permissions instead: `githubAppCredential` asks for those per call.
 */
export const GITHUB_SCOPES: ScopeDef[] = [{ scope: "repo", allows: [{ act: "github.*", res: "github:**" }] }];

/** Slack bot scopes for the Slack pack. */
export const SLACK_SCOPES: ScopeDef[] = [{ scope: "chat:write", allows: [{ act: "slack.message.post", res: "slack:**" }] }];

/** Sites by environment, the way a deployment platform might scope tokens: `deploy:staging`, `deploy:production`. */
export const SITE_SCOPES: ScopeDef[] = [{ scope: "deploy:{env}", allows: [{ act: "site.deploy", res: "site:*/{env}" }] }];
