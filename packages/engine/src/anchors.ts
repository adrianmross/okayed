import { CATALOG } from "./catalog.ts";
import { canonRes, parseRes } from "./resource.ts";
import type { Condition, Effect, Targets } from "./types.ts";

/**
 * What a sentence pins down, extracted with plain rules. The engine binds grants only to these and to the
 * request they point at; the model's reading of the sentence is never trusted for scope.
 */
export interface Anchors {
  acts: string[];
  negatedActs: string[];
  prNumbers: number[];
  /** `owner/repo`, lowercase, known or literally written. */
  repos: string[];
  shas: string[];
  sites: string[];
  envs: string[];
  negatedEnvs: string[];
  agents: string[];
  /** Exact resources of registered types: known targets named in the words, or written out (`slack:acme/releases`). */
  named: string[];
  /** Lifetime the person stated, seconds. */
  ttl?: number;
  /** The person asked for no expiry ("forever"); grants always expire, so this is reported, not honored. */
  unbounded: boolean;
  uses?: number;
  conditions: Condition[];
  /** "yes", "go ahead", "approve": refers to whatever is pending. */
  approves: boolean;
  /** "the site", "the website": a site without a name. */
  genericSite: boolean;
}

const VERBS: [string, RegExp][] = [
  ["github.pr.merge", /\bmerg(?:e|es|ed|ing)\b/g],
  ["github.pr.comment", /\bcomment(?:s|ed|ing)?\b/g],
  ["github.read", /\b(?:read(?:s|ing)?|read-only|view(?:s|ing)?|look(?:s|ing)? at|brows(?:e|es|ing)|inspect(?:s|ing)?|clone|fetch(?:es|ing)?)\b/g],
  ["site.deploy", /\b(?:deploy(?:s|ed|ing|ment|ments)?|ship(?:s|ped|ping)?|publish(?:es|ed|ing)?|releas(?:e|es|ed|ing)|go(?:es)? live|push(?:es)? (?:it )?live)\b/g],
  ["spend.money", /\b(?:spend(?:s|ing)?|spent|pay(?:s|ing)?|paid|buy(?:s|ing)?|bought|purchas(?:e|es|ed|ing)|charg(?:e|es|ed|ing)|money)\b/g],
];

/** Patterns for registered actions, from their keywords. A single word also matches its -s, -es, -ed and -ing forms. */
function customVerbs(): [string, RegExp][] {
  const out: [string, RegExp][] = [];
  for (const spec of Object.values(CATALOG)) {
    if (!spec.keywords?.length) continue;
    const alts = spec.keywords.map((k) => k.split(" ").map(escapeRe).join("\\s+") + (k.includes(" ") ? "" : "(?:s|es|ed|d|ing)?"));
    out.push([spec.act, new RegExp(`\\b(?:${alts.join("|")})\\b`, "g")]);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\*-]/g, "\\$&");
}

/** Where a text names `name` on its own: "#releases", not "#releases-old" or "pre-releases". */
function mention(name: string): RegExp | null {
  const n = name.trim().toLowerCase();
  return n ? new RegExp(`(?<![\\w#@.-])${escapeRe(n)}(?![\\w-])`, "g") : null;
}

const NEGATORS = /\b(?:not|never|no|don't|dont|do not|doesn't|without|nor|except|but not)\s+(?:\w+\s+){0,2}$/;

const ENVS: [string, RegExp][] = [
  ["production", /\b(?:production|prod|live)\b/g],
  ["staging", /\b(?:staging|stage)\b/g],
  ["preview", /\b(?:preview|dev|development)\b/g],
];

const NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, fifteen: 15, twenty: 20, thirty: 30,
  "forty-five": 45, half: 0.5,
};

const UNITS: [RegExp, number][] = [
  [/^s(?:ec(?:ond)?s?)?$/, 1],
  [/^m(?:in(?:ute)?s?)?$/, 60],
  [/^h(?:(?:ou)?rs?)?$/, 3600],
  [/^w(?:(?:ee)?ks?)?$/, 604800],
  [/^d(?:ays?)?$/, 86400],
];

function num(word: string): number | undefined {
  if (/^\d+(?:\.\d+)?$/.test(word)) return Number(word);
  return NUMBERS[word];
}

function negated(text: string, index: number): boolean {
  const clauseStart = Math.max(text.lastIndexOf(",", index), text.lastIndexOf(";", index), text.lastIndexOf(".", index));
  const before = text.slice(clauseStart + 1, index);
  return NEGATORS.test(before);
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** Lowercases and folds curly quotes so the patterns stay simple. */
export function normalize(utterance: string): string {
  return utterance.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

export function extractAnchors(utterance: string, targets: Targets): Anchors {
  const t = normalize(utterance);
  const a: Anchors = {
    acts: [],
    negatedActs: [],
    prNumbers: [],
    repos: [],
    shas: [],
    sites: [],
    envs: [],
    negatedEnvs: [],
    agents: [],
    named: [],
    unbounded: false,
    conditions: [],
    approves: /\b(?:approve[ds]?|approving|go ahead|yes|yep|ok|okay|okayed|sure|do it|lgtm|ship it|green ?light|confirm(?:ed)?)\b/.test(t),
    genericSite: /\b(?:the|our|my) (?:web ?site|site|web ?app|app|homepage)\b/.test(t),
  };

  // Resources of registered types: known ones by the names people use, and any written out in full (case kept, for
  // types that keep it). Their words are names, not verbs: "#releases" is a channel, not a request to release.
  let words = t;
  const blank = (s: string) => " ".repeat(s.length);
  for (const n of targets.named ?? []) {
    const res = canonRes(n.res);
    if (!res) continue;
    for (const name of n.names) {
      const re = mention(name);
      if (!re || !re.test(words)) continue;
      a.named.push(res);
      words = words.replace(mention(name)!, blank);
    }
  }
  const raw = utterance.replace(/[’‘]/g, "'").replace(/\s+/g, " ");
  for (const m of raw.matchAll(/(?<![\w/])([a-zA-Z][a-zA-Z0-9+.-]*:[^\s,;]+?)(?=[.,;!?)]*(?:\s|$))/g)) {
    if (parseRes(m[1]!)?.kind !== "custom") continue;
    a.named.push(canonRes(m[1]!)!);
    words = words.split(m[1]!.toLowerCase()).join(blank(m[1]!));
  }
  a.named = uniq(a.named);

  for (const [act, re] of [...VERBS, ...customVerbs()]) {
    for (const m of words.matchAll(re)) {
      (negated(words, m.index) ? a.negatedActs : a.acts).push(act);
    }
  }
  // "read-only" talks about scope, not about a separate read on top of something else.
  a.acts = uniq(a.acts).filter((x) => !a.negatedActs.includes(x));
  a.negatedActs = uniq(a.negatedActs);

  for (const m of t.matchAll(/(?:#|\bpr\s*#?|\bpull request\s*#?|\bpull\s+#?|\bissue\s*#?)(\d{1,9})\b/g)) {
    a.prNumbers.push(Number(m[1]));
  }
  a.prNumbers = uniq(a.prNumbers);

  const known = new Set(targets.repos.map((r) => r.toLowerCase()));
  for (const m of t.matchAll(/\b([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9._-]*)\b/g)) {
    const full = `${m[1]}/${m[2]}`;
    const prose = /^(?:and|or|read|write|on|off|yes|no|either)$/.test(m[1]!) || /^(?:and|or|write|read|off|no)$/.test(m[2]!);
    if (known.has(full) || !prose) a.repos.push(full);
  }
  for (const repo of known) {
    const name = repo.split("/")[1]!;
    if (new RegExp(`(?<![\\w/.-])${name.replace(/[.]/g, "\\.")}(?![\\w/-])`).test(t)) a.repos.push(repo);
  }
  a.repos = uniq(a.repos);

  for (const m of t.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
    if (/[a-f]/.test(m[0]) && /\d/.test(m[0])) a.shas.push(m[0]);
  }

  for (const site of targets.sites) {
    const host = site.host.toLowerCase();
    const label = host.split(".")[0]!;
    if (t.includes(host) || new RegExp(`\\b${label}\\b`).test(t)) a.sites.push(host);
  }
  for (const m of t.matchAll(/\b((?:[a-z0-9-]+\.)+(?:com|org|net|dev|io|app|ai|co|xyz|site|page|pages\.dev|workers\.dev))\b/g)) {
    if (!a.sites.includes(m[1]!)) a.sites.push(m[1]!);
  }
  a.sites = uniq(a.sites);

  for (const [env, re] of ENVS) {
    for (const m of t.matchAll(re)) {
      // "go live" and "push it live" are verbs for deploying, not an environment on their own.
      if (env === "production" && m[0] === "live" && /\b(?:go|goes|push(?:es)?(?: it)?)\s+$/.test(t.slice(0, m.index))) continue;
      (negated(t, m.index) ? a.negatedEnvs : a.envs).push(env);
    }
  }
  a.negatedEnvs = uniq(a.negatedEnvs);
  a.envs = uniq(a.envs).filter((e) => !a.negatedEnvs.includes(e));

  for (const agent of targets.agents) {
    const name = agent.replace(/^agent:/, "").toLowerCase();
    if (new RegExp(`\\b${name.replace(/[.]/g, "\\.")}\\b`).test(t)) a.agents.push(agent);
  }

  const dur = /\bfor (?:the next |another |up to )?(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|ten|fifteen|twenty|thirty|forty-five|half)(?: an?)? ?(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w)\b/.exec(t);
  if (dur) {
    const n = num(dur[1]!);
    const unit = UNITS.find(([re]) => re.test(dur[2]!))?.[1];
    if (n !== undefined && unit !== undefined) a.ttl = Math.round(n * unit);
  } else if (/\bfor (?:the next |an? )?(?:hour)\b/.test(t)) {
    a.ttl = 3600;
  }
  if (/\b(?:forever|permanent(?:ly)?|indefinitely|no expiry|never expires?|from now on|until i say otherwise)\b/.test(t)) a.unbounded = true;

  const cond = /\b(?:once|if|when|after|as soon as)\s+(?:the\s+)?(?:ci|checks?|tests?|builds?)\b[^.;,]*?\b(?:pass(?:es|ed)?|green|succeed(?:s|ed)?|clear)/.test(t);
  if (cond) a.conditions.push({ c: "checks.pass" });

  const times = /\b(\d+|one|two|three|four|five|ten) times\b/.exec(t) ?? /\bup to (\d+|two|three|four|five|ten|twenty|thirty) (?:\w+ )?(?:times|merges|deploys|deployments|comments|reads|uses|requests|pull requests|prs)\b/.exec(t);
  if (times) a.uses = num(times[1]!);
  else if (/\btwice\b/.test(t)) a.uses = 2;
  else if (/\b(?:just )?once\b(?!\s+(?:the\s+)?(?:ci|checks?|tests?|builds?|it|they|that)\b)/.test(t) || /\bone time\b/.test(t)) a.uses = 1;

  return a;
}

/** What a policy clause says: effect words and the action families it names. */
export interface PolicyClause {
  text: string;
  effect?: Effect;
  acts: string[];
  /** "anything", "everything" with no family: applies to all actions. */
  everything: boolean;
  repos: string[];
  sites: string[];
  envs: string[];
  agents: string[];
  /** Exact resources of registered types the clause names. */
  named: string[];
  conditions: Condition[];
  /** How long the policy should stand, seconds. */
  ttl?: number;
  /** How many times in all. */
  uses?: number;
  /** "forever", "from now on": the person chose no end. */
  unbounded: boolean;
}

const EFFECTS: [Effect, RegExp][] = [
  ["deny", /\b(?:never|block|deny|forbid|refuse|don't (?:let|allow)|do not (?:let|allow)|no one may)\b/],
  ["ask", /\b(?:ask(?: me)?|check with me|confirm with me|prompt me|wait for me|need my okay|require (?:my )?approval)\b/],
  ["allow", /\b(?:auto[- ]?approve[ds]?|always allow|allow|let (?:it|them|the agents?|assistant)|don't ask|without asking|okay to|fine to|trust(?:ed)?)\b/],
];

/** Splits a policy sentence into clauses and anchors each one. */
export function policyClauses(utterance: string, targets: Targets): PolicyClause[] {
  const parts = normalize(utterance)
    .split(/[;.\n]|,\s*(?=(?:and |but )?(?:auto|always|never|ask|allow|let|block|deny|don't|do not))|\s+(?:but|and)\s+(?=(?:auto|always|never|ask|allow|let|block|deny|don't|do not))/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map((text) => {
    const a = extractAnchors(text, targets);
    let effect: Effect | undefined;
    for (const [e, re] of EFFECTS) {
      if (re.test(text)) {
        effect = e;
        break;
      }
    }
    // "don't ask" means allow, though it contains "ask".
    if (/\b(?:don't|do not|without) ask/.test(text)) effect = "allow";
    let acts = uniq([...a.acts, ...a.negatedActs]);
    if (/\bgithub\b/.test(text) && acts.length === 0) acts = ["github.*"];
    if (/\bread-only\b|\bread only\b/.test(text)) acts = ["github.read"];
    const everything = acts.length === 0 && /\b(?:anything|everything|all|any action)\b/.test(text);
    // In "never deploy to production", "never" is the rule's effect, not a negated place: block rules keep it as scope.
    const envs = effect === "deny" ? uniq([...a.envs, ...a.negatedEnvs]) : a.envs;
    const clause: PolicyClause = { text, acts, everything, repos: a.repos, sites: a.sites, envs, agents: a.agents, named: a.named, conditions: a.conditions, unbounded: a.unbounded };
    if (effect) clause.effect = effect;
    if (a.ttl !== undefined) clause.ttl = a.ttl;
    if (a.uses !== undefined) clause.uses = a.uses;
    return clause;
  });
}
