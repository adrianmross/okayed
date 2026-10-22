import { extractAnchors, type Anchors } from "./anchors.ts";
import { CATALOG, fitsAction, riskOf } from "./catalog.ts";
import { decideAll, type Decision } from "./policy.ts";
import { canonRes, formatRes, isPattern, labelRes, parseRes, repoOf } from "./resource.ts";
import type { Beyond, Condition, GrantDraft, Policy, Request, Targets, Unix } from "./types.ts";

/** What the model proposed, coerced from untrusted JSON. Every field is optional and only ever narrows. */
export interface Proposal {
  request?: string;
  act?: string;
  res?: string[];
  ttl?: number;
  uses?: number;
  when?: Condition[];
  aud?: string;
}

export interface NarrowInput {
  utterance: string;
  /** The model's draft. Untrusted: may be missing, malformed or hostile. */
  proposal: unknown;
  requests: Request[];
  targets: Targets;
  policy: Policy;
  now: Unix;
  /** A request picked by an unambiguous gesture (a button), bypassing word matching. */
  select?: string;
}

export type NarrowResult =
  | {
      kind: "grant";
      draft: GrantDraft;
      /** The proposal as the model wrote it, normalized for display. */
      asked: Proposal;
      beyond: Beyond[];
      decision: Decision;
      notes: string[];
    }
  | { kind: "question"; question: string; options: string[]; beyond: Beyond[] }
  | { kind: "refuse"; reason: string; beyond: Beyond[]; decision?: Decision };

const KNOWN_CONDITIONS = new Set(["checks.pass", "before"]);

function int(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? Math.floor(x) : undefined;
}

/** Turns whatever the model returned into a `Proposal`, dropping anything of the wrong type. */
export function coerceProposal(raw: unknown): Proposal {
  const p: Proposal = {};
  if (!raw || typeof raw !== "object") return p;
  const o = raw as Record<string, unknown>;
  if (typeof o.request === "string") p.request = o.request;
  if (typeof o.act === "string") p.act = o.act.trim();
  else if (Array.isArray(o.act) && typeof o.act[0] === "string") p.act = o.act[0];
  if (typeof o.res === "string") p.res = [o.res];
  else if (Array.isArray(o.res)) p.res = o.res.filter((x): x is string => typeof x === "string");
  const ttl = int(o.ttl);
  if (ttl !== undefined) p.ttl = ttl;
  const uses = int(o.uses);
  if (uses !== undefined) p.uses = uses;
  if (Array.isArray(o.when)) {
    p.when = o.when
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as { c?: unknown }).c === "string")
      .map((c) => {
        const out: Condition = { c: c.c as string };
        if (typeof c.v === "string" || typeof c.v === "number") out.v = c.v;
        return out;
      });
  }
  if (typeof o.aud === "string") p.aud = o.aud;
  return p;
}

function duration(s: number): string {
  if (s >= 86400 * 365) return `${Math.round(s / (86400 * 365))} years`;
  if (s >= 86400) return `${Math.round(s / 86400)} d`;
  if (s % 3600 === 0 && s >= 3600) return `${s / 3600} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
}

function usesLabel(n: number): string {
  return n === 1 ? "once" : `${n} times`;
}

/** True if a request's resources fit what the words pin down. Anchors that are absent don't constrain. */
function fitsAnchors(r: Request, a: Anchors): boolean {
  if (a.acts.length && !a.acts.includes(r.act)) return false;
  if (a.negatedActs.includes(r.act)) return false;
  const parsed = r.res.map(parseRes);
  const any = (f: (x: NonNullable<(typeof parsed)[number]>) => boolean) => parsed.some((x) => x !== null && f(x));
  if (a.prNumbers.length && !any((x) => x.kind === "github.pr" && a.prNumbers.includes(x.number))) return false;
  if (a.repos.length && !any((x) => a.repos.includes(repoOf(x) ?? ""))) return false;
  if (a.shas.length && !any((x) => x.kind === "github.pr" && !!x.sha && a.shas.some((s) => x.sha!.startsWith(s)))) return false;
  if (a.sites.length && !any((x) => x.kind === "site" && a.sites.includes(x.host))) return false;
  if (a.envs.length && !any((x) => x.kind === "site" && a.envs.includes(x.env))) return false;
  if (a.agents.length && !a.agents.includes(r.aud)) return false;
  return true;
}

function describeRequest(r: Request): string {
  const verb = CATALOG[r.act]?.verb ?? r.act;
  return `${r.aud.replace(/^agent:/, "")}: ${verb} ${r.res.map(labelRes).join(", ")}`;
}

type Base = { act: string; res: string[]; aud: string; request: Request | null };
type Bound = { ok: true; base: Base } | { ok: false; result: NarrowResult };

function question(question: string, options: string[], beyond: Beyond[]): Bound {
  return { ok: false, result: { kind: "question", question, options, beyond } };
}

function refuse(reason: string, beyond: Beyond[]): Bound {
  return { ok: false, result: { kind: "refuse", reason, beyond } };
}

/** Builds exact resources for an approval given before any request, from the words and known targets only. */
function bindFromWords(act: string, a: Anchors, t: Targets, beyond: Beyond[]): { ok: true; res: string[] } | { ok: false; bound: Bound } {
  const spec = CATALOG[act]!;
  if (spec.res.includes("github.pr") && (act !== "github.read" || a.prNumbers.length)) {
    if (a.prNumbers.length > 1) return { ok: false, bound: question("Which pull request?", a.prNumbers.map((n) => `#${n}`), beyond) };
    const n = a.prNumbers[0];
    if (n === undefined) return { ok: false, bound: question(`Which pull request should I let it ${spec.verb}?`, t.prs.map((p) => `${p.repo}#${p.number}`), beyond) };
    const prs = t.prs.filter((p) => p.number === n && (!a.repos.length || a.repos.includes(p.repo)));
    let repo = a.repos.length === 1 ? a.repos[0] : prs.length === 1 ? prs[0]!.repo : t.repos.length === 1 ? t.repos[0] : undefined;
    if (a.repos.length > 1) return { ok: false, bound: question(`#${n} in which repository?`, a.repos, beyond) };
    if (!repo) return { ok: false, bound: question(`#${n} in which repository?`, t.repos, beyond) };
    const [owner, name] = repo.split("/") as [string, string];
    let sha: string | undefined;
    if (spec.pinCommit) {
      const head = prs.find((p) => p.repo === repo)?.head?.toLowerCase();
      if (a.shas.length) {
        sha = head && a.shas.some((s) => head.startsWith(s)) ? head : a.shas.find((s) => s.length === 40);
        if (!sha) return { ok: false, bound: question(`I can't pin commit ${a.shas[0]} of #${n} to a full SHA. Which commit?`, head ? [head.slice(0, 7)] : [], beyond) };
      } else if (head) {
        sha = head;
      } else {
        return { ok: false, bound: question(`Which commit of #${n}? I can't see its head commit; ask the agent to file a request so it can be pinned.`, [], beyond) };
      }
    }
    return { ok: true, res: [formatRes({ kind: "github.pr", owner, repo: name, number: n, ...(sha ? { sha } : {}) })] };
  }
  if (spec.res.includes("github.repo")) {
    if (a.repos.length) return { ok: true, res: a.repos.map((r) => `github:${r}`) };
    if (t.repos.length === 1) return { ok: true, res: [`github:${t.repos[0]}`] };
    return { ok: false, bound: question("Which repository?", t.repos, beyond) };
  }
  if (spec.res.includes("site")) {
    let host = a.sites.length === 1 ? a.sites[0] : undefined;
    if (a.sites.length > 1) return { ok: false, bound: question("Which site?", a.sites, beyond) };
    if (!host) {
      if (t.sites.length === 1) host = t.sites[0]!.host;
      else return { ok: false, bound: question("Which site?", t.sites.map((s) => s.host), beyond) };
    }
    const envs = t.sites.find((s) => s.host === host)?.envs ?? [];
    let env = a.envs.length === 1 ? a.envs[0] : undefined;
    if (a.envs.length > 1) return { ok: false, bound: question("Which environment?", a.envs, beyond) };
    if (!env) {
      const allowed = envs.filter((e) => !a.negatedEnvs.includes(e));
      if (allowed.length === 1) env = allowed[0];
      else return { ok: false, bound: question(`Which environment of ${host}?`, allowed.length ? allowed : ["production", "staging", "preview"], beyond) };
    }
    if (envs.length && !envs.includes(env!)) return { ok: false, bound: question(`${host} has no ${env} environment. Which one?`, envs, beyond) };
    return { ok: true, res: [`site:${host}/${env}`] };
  }
  return { ok: false, bound: refuse(`${spec.verb[0]!.toUpperCase()}${spec.verb.slice(1)}ing needs a request from the agent with the exact amount; I won't make one up.`, beyond) };
}

function bind(input: NarrowInput, a: Anchors, p: Proposal, beyond: Beyond[]): Bound {
  const live = input.requests.filter((r) => r.exp > input.now);
  if (input.select) {
    const r = live.find((x) => x.id === input.select);
    if (!r) return refuse("That request is no longer pending.", beyond);
    return { ok: true, base: { act: r.act, res: r.res, aud: r.aud, request: r } };
  }
  const candidates = live.filter((r) => fitsAnchors(r, a));
  let chosen: Request | undefined;
  if (p.request !== undefined) {
    chosen = candidates.find((r) => r.id === p.request);
    if (!chosen) {
      beyond.push({ field: "request", asked: p.request, why: "your words don't point at that request" });
    }
  }
  const specific = a.acts.length + a.prNumbers.length + a.repos.length + a.sites.length + a.envs.length + a.shas.length > 0;
  if (!chosen && candidates.length === 1 && (specific || a.approves)) chosen = candidates[0];
  if (!chosen && candidates.length > 1) {
    return question("Which request do you mean?", candidates.map(describeRequest), beyond);
  }
  if (chosen) {
    if (a.negatedActs.includes(chosen.act)) return refuse(`You said not to ${CATALOG[chosen.act]?.verb ?? chosen.act}.`, beyond);
    return { ok: true, base: { act: chosen.act, res: chosen.res, aud: chosen.aud, request: chosen } };
  }

  // No pending request fits: a pre-approval, bound from the words alone.
  if (a.acts.length === 0) {
    if (live.length) return refuse("Your words don't match any pending request.", beyond);
    return question("What should I approve? Nothing is pending.", [], beyond);
  }
  let act: string;
  if (a.acts.length > 1) {
    if (p.act && a.acts.includes(p.act)) {
      act = p.act;
      for (const other of a.acts.filter((x) => x !== act)) {
        beyond.push({ field: "act", asked: other, why: "one action per grant; ask again for this one" });
      }
    } else {
      return question("Which should I approve first? One action per grant.", a.acts.map((x) => CATALOG[x]?.verb ?? x), beyond);
    }
  } else {
    act = a.acts[0]!;
  }
  if (!CATALOG[act]) return refuse(`${act} is not an action okayed knows.`, beyond);
  const res = bindFromWords(act, a, input.targets, beyond);
  if (!res.ok) return res.bound;

  let aud: string | undefined;
  if (a.agents.length === 1) aud = a.agents[0];
  else if (a.agents.length > 1) return question("Which agent?", a.agents, beyond);
  else if (p.aud && input.targets.agents.includes(p.aud) && input.targets.agents.length === 1) aud = p.aud;
  else if (input.targets.agents.length === 1) aud = input.targets.agents[0];
  if (!aud) return question("Which agent is this for?", input.targets.agents, beyond);
  return { ok: true, base: { act, res: res.res, aud, request: null } };
}

/**
 * Turns a model's proposal into the narrowest grant the person's words and the pending request support,
 * then applies policy. Never returns anything broader than `base`; reports everything it cut.
 */
export function narrowGrant(input: NarrowInput): NarrowResult {
  const a = extractAnchors(input.select ? "" : input.utterance, input.targets);
  const p = coerceProposal(input.proposal);
  const beyond: Beyond[] = [];
  const notes: string[] = [];

  const bound = bind(input, a, p, beyond);
  if (!bound.ok) return bound.result;
  const base = bound.base;
  const spec = CATALOG[base.act];
  if (!spec) return { kind: "refuse", reason: `${base.act} is not an action okayed knows.`, beyond };
  const said = base.request ? "the agent asked" : "you said";

  // Action: exactly the bound one.
  if (p.act !== undefined && p.act !== base.act) {
    beyond.push({
      field: "act",
      asked: p.act,
      granted: base.act,
      why: isPattern(p.act) ? "wildcard actions are never granted" : `${said} ${base.act}, not ${p.act}`,
    });
  }

  // Resources: the proposal intersected with the base, exact forms only.
  const baseRes = base.res.map((r) => canonRes(r)).filter((r): r is string => r !== null && fitsAction(base.act, r));
  if (baseRes.length === 0) {
    return { kind: "refuse", reason: `The request names no exact target that ${base.act} can apply to.`, beyond };
  }
  let res: string[] = [];
  for (const r of p.res ?? []) {
    if (isPattern(r)) beyond.push({ field: "res", asked: r, why: "wildcards are never granted; grants name exact targets" });
    else {
      const c = canonRes(r);
      if (!c) beyond.push({ field: "res", asked: r, why: "not a resource okayed can pin exactly" });
      else if (!baseRes.includes(c)) beyond.push({ field: "res", asked: r, why: `${said} ${baseRes.map(labelRes).join(", ")}, not this` });
      else if (!res.includes(c)) res.push(c);
    }
  }
  if (res.length === 0) {
    if (p.res?.length) notes.push(`The draft named no valid target, so the grant uses exactly what ${said}.`);
    res = baseRes;
  }
  const blockedEnv = res.filter((r) => {
    const x = parseRes(r);
    return x?.kind === "site" && a.negatedEnvs.includes(x.env);
  });
  for (const r of blockedEnv) beyond.push({ field: "res", asked: r, why: "you said not this environment" });
  res = res.filter((r) => !blockedEnv.includes(r));
  if (res.length === 0) return { kind: "refuse", reason: "Nothing is left once the environments you excluded are removed.", beyond };

  // Policy: drop resources it denies; the rest decide together.
  const allowedRes = res.filter((r) => decideAll(input.policy, base.act, [r], input.now).verdict !== "deny");
  for (const r of res.filter((x) => !allowedRes.includes(x))) {
    beyond.push({ field: "res", asked: r, why: decideAll(input.policy, base.act, [r], input.now).reason });
  }
  if (allowedRes.length === 0) {
    const decision = decideAll(input.policy, base.act, res, input.now);
    return { kind: "refuse", reason: decision.reason, beyond, decision };
  }
  res = allowedRes;
  const decision = decideAll(input.policy, base.act, res, input.now);

  // Lifetime: the shortest of what was said, the catalog, the policy and the draft.
  const caps: [number, string][] = [[spec.maxTtl, `${spec.verb} grants last at most ${duration(spec.maxTtl)}`]];
  if (decision.caps.ttl !== undefined) caps.push([decision.caps.ttl, `your policy caps this at ${duration(decision.caps.ttl)}`]);
  if (a.ttl !== undefined) caps.push([a.ttl, `you said ${duration(a.ttl)}`]);
  let ttl = a.ttl ?? spec.ttl;
  let ttlWhy = a.ttl !== undefined ? `you said ${duration(a.ttl)}` : `the shortest reasonable lifetime for ${spec.verb} is ${duration(spec.ttl)}`;
  for (const [cap, why] of caps) {
    if (cap < ttl) {
      ttl = cap;
      ttlWhy = why;
    }
  }
  if (p.ttl !== undefined) {
    if (p.ttl > ttl) beyond.push({ field: "ttl", asked: duration(p.ttl), granted: duration(ttl), why: ttlWhy });
    else if (p.ttl >= 60) ttl = p.ttl;
  }
  if (a.ttl !== undefined && a.ttl > ttl && !(p.ttl !== undefined && p.ttl > ttl)) {
    beyond.push({ field: "ttl", asked: duration(a.ttl), granted: duration(ttl), why: ttlWhy });
  }
  if (a.unbounded) beyond.push({ field: "ttl", asked: "no expiry", granted: duration(ttl), why: "every grant expires" });

  // Uses: the fewest of what was said, the catalog, the policy and the draft.
  let uses = a.uses ?? spec.uses;
  let usesWhy = a.uses !== undefined ? `you said ${usesLabel(a.uses)}` : `${spec.verb} grants default to ${usesLabel(spec.uses)}`;
  const useCaps: [number, string][] = [[spec.maxUses, `${spec.verb} grants allow at most ${usesLabel(spec.maxUses)}`]];
  if (decision.caps.uses !== undefined) useCaps.push([decision.caps.uses, `your policy allows ${usesLabel(decision.caps.uses)}`]);
  for (const [cap, why] of useCaps) {
    if (cap < uses) {
      uses = cap;
      usesWhy = why;
    }
  }
  if (p.uses !== undefined) {
    if (p.uses > uses) beyond.push({ field: "uses", asked: usesLabel(p.uses), granted: usesLabel(uses), why: usesWhy });
    else if (p.uses >= 1) uses = p.uses;
  }

  if (a.uses !== undefined && a.uses > uses && !(p.uses !== undefined && p.uses > uses)) {
    beyond.push({ field: "uses", asked: usesLabel(a.uses), granted: usesLabel(uses), why: usesWhy });
  }

  // Conditions: the draft's known ones, plus any the person stated. Conditions only narrow.
  const when: Condition[] = [];
  const addCond = (c: Condition) => {
    if (!when.some((w) => w.c === c.c && w.v === c.v)) when.push(c);
  };
  for (const c of p.when ?? []) {
    if (!KNOWN_CONDITIONS.has(c.c)) beyond.push({ field: "when", asked: c.c, why: "not a condition verifiers can check" });
    else if (c.c === "checks.pass" && base.act !== "github.pr.merge") beyond.push({ field: "when", asked: c.c, why: "only applies to merges" });
    else if (c.c === "before" && (typeof c.v !== "number" || c.v <= input.now)) beyond.push({ field: "when", asked: `before ${c.v}`, why: "not a future time" });
    else addCond(c);
  }
  for (const c of a.conditions) if (c.c !== "checks.pass" || base.act === "github.pr.merge") addCond(c);

  // Audience: the bound one.
  if (p.aud !== undefined && p.aud !== base.aud) {
    beyond.push({ field: "aud", asked: p.aud, granted: base.aud, why: `${said} ${base.aud}` });
  }

  const draft: GrantDraft = {
    aud: base.aud,
    act: base.act,
    res,
    when,
    nbf: input.now,
    exp: input.now + ttl,
    uses,
    risk: riskOf(base.act, res),
    from: { utterance: input.utterance, request: base.request?.id ?? null },
  };
  const asked: Proposal = { ...p };
  return { kind: "grant", draft, asked, beyond, decision, notes };
}
