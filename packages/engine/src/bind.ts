import type { Anchors } from "./anchors.ts";
import { CATALOG, fitsAction } from "./catalog.ts";
import { BUILTIN_KINDS, canonRes, formatRes, labelRes, parseRes, repoOf } from "./resource.ts";
import type { Beyond, Request, Targets, Unix } from "./types.ts";

/**
 * Binding: deciding which exact action, targets and agent the person's words refer to, before any narrowing.
 * Either one pending request the words point at, or (for a pre-approval) targets built from the words and the
 * known world. Anything ambiguous becomes a question.
 */

/** The thing a grant is cut from: never broader than this. */
export interface Base {
  act: string;
  res: string[];
  aud: string;
  request: Request | null;
}

export type Bound =
  | { ok: true; base: Base }
  | { ok: false; question: string; options: string[] }
  | { ok: false; reason: string };

export interface BindInput {
  requests: Request[];
  targets: Targets;
  now: Unix;
  /** A request picked by an unambiguous gesture (a button), bypassing word matching. */
  select?: string;
  /** The request id the model's draft points at, if any. */
  draftRequest?: string;
  /** The action the draft names; used only to break a tie between actions the words both name. */
  draftAct?: string;
}

/** A bind that produced a question or a refusal instead of a base. */
export type Miss = Exclude<Bound, { ok: true }>;

const question = (q: string, options: string[]): Miss => ({ ok: false, question: q, options });
const refuse = (reason: string): Miss => ({ ok: false, reason });

/** True if a request's resources fit what the words pin down. Anchors that are absent don't constrain. */
function fitsAnchors(r: Request, a: Anchors): boolean {
  if (a.acts.length && !a.acts.includes(r.act)) return false;
  if (a.negatedActs.includes(r.act)) return false;
  if (a.agents.length && !a.agents.includes(r.aud)) return false;
  const parsed = r.res.map(parseRes);
  // A request for a registered type is pinned by named targets; repos, sites and environments are about built-ins
  // (an email domain is not a site).
  if (parsed.every((x) => x?.kind === "custom")) return !a.named.length || r.res.some((x) => a.named.includes(canonRes(x) ?? ""));
  const any = (f: (x: NonNullable<(typeof parsed)[number]>) => boolean) => parsed.some((x) => x !== null && f(x));
  if (a.prNumbers.length && !any((x) => x.kind === "github.pr" && a.prNumbers.includes(x.number))) return false;
  if (a.repos.length && !any((x) => a.repos.includes(repoOf(x) ?? ""))) return false;
  if (a.shas.length && !any((x) => x.kind === "github.pr" && !!x.sha && a.shas.some((s) => x.sha!.startsWith(s)))) return false;
  if (a.sites.length && !any((x) => x.kind === "site" && a.sites.includes(x.host))) return false;
  if (a.envs.length && !any((x) => x.kind === "site" && a.envs.includes(x.env))) return false;
  return true;
}

function describeRequest(r: Request): string {
  const verb = CATALOG[r.act]?.verb ?? r.act;
  return `${r.aud.replace(/^agent:/, "")}: ${verb} ${r.res.map(labelRes).join(", ")}`;
}



/** Builds exact resources for an approval given before any request, from the words and known targets only. */
function bindFromWords(act: string, a: Anchors, t: Targets): { ok: true; res: string[] } | Miss {
  const spec = CATALOG[act]!;
  // A registered action binds to the known targets the words name, and never to one they don't.
  if (spec.res.every((k) => !BUILTIN_KINDS.has(k))) {
    const named = a.named.filter((r) => fitsAction(act, r));
    if (named.length) return { ok: true, res: named };
    const known = (t.named ?? []).filter((n) => {
      const c = canonRes(n.res);
      return c !== null && fitsAction(act, c);
    });
    return question(`Where should I let it ${spec.verb}?`, known.map((n) => n.names[0] ?? labelRes(n.res)));
  }
  if (spec.res.includes("github.pr") && (act !== "github.read" || a.prNumbers.length)) {
    if (a.prNumbers.length > 1) return question("Which pull request?", a.prNumbers.map((n) => `#${n}`));
    const n = a.prNumbers[0];
    if (n === undefined) return question(`Which pull request should I let it ${spec.verb}?`, t.prs.map((p) => `${p.repo}#${p.number}`));
    const prs = t.prs.filter((p) => p.number === n && (!a.repos.length || a.repos.includes(p.repo)));
    let repo = a.repos.length === 1 ? a.repos[0] : prs.length === 1 ? prs[0]!.repo : t.repos.length === 1 ? t.repos[0] : undefined;
    if (a.repos.length > 1) return question(`#${n} in which repository?`, a.repos);
    if (!repo) return question(`#${n} in which repository?`, t.repos);
    const [owner, name] = repo.split("/") as [string, string];
    let sha: string | undefined;
    if (spec.pinCommit) {
      const head = prs.find((p) => p.repo === repo)?.head?.toLowerCase();
      if (a.shas.length) {
        sha = head && a.shas.some((s) => head.startsWith(s)) ? head : a.shas.find((s) => s.length === 40);
        if (!sha) return question(`I can't pin commit ${a.shas[0]} of #${n} to a full SHA. Which commit?`, head ? [head.slice(0, 7)] : []);
      } else if (head) {
        sha = head;
      } else {
        return question(`Which commit of #${n}? I can't see its head commit; ask the agent to file a request so it can be pinned.`, []);
      }
    }
    return { ok: true, res: [formatRes({ kind: "github.pr", owner, repo: name, number: n, ...(sha ? { sha } : {}) })] };
  }
  if (spec.res.includes("github.repo")) {
    if (a.repos.length) return { ok: true, res: a.repos.map((r) => `github:${r}`) };
    if (t.repos.length === 1) return { ok: true, res: [`github:${t.repos[0]}`] };
    return question("Which repository?", t.repos);
  }
  if (spec.res.includes("site")) {
    let host = a.sites.length === 1 ? a.sites[0] : undefined;
    if (a.sites.length > 1) return question("Which site?", a.sites);
    if (!host) {
      if (t.sites.length === 1) host = t.sites[0]!.host;
      else return question("Which site?", t.sites.map((s) => s.host));
    }
    const envs = t.sites.find((s) => s.host === host)?.envs ?? [];
    let env = a.envs.length === 1 ? a.envs[0] : undefined;
    if (a.envs.length > 1) return question("Which environment?", a.envs);
    if (!env) {
      const allowed = envs.filter((e) => !a.negatedEnvs.includes(e));
      if (allowed.length === 1) env = allowed[0];
      else return question(`Which environment of ${host}?`, allowed.length ? allowed : ["production", "staging", "preview"]);
    }
    if (envs.length && !envs.includes(env!)) return question(`${host} has no ${env} environment. Which one?`, envs);
    return { ok: true, res: [`site:${host}/${env}`] };
  }
  return refuse(`${spec.verb[0]!.toUpperCase()}${spec.verb.slice(1)}ing needs a request from the agent with the exact amount; I won't make one up.`);
}

export function bind(input: BindInput, a: Anchors, beyond: Beyond[]): Bound {
  const live = input.requests.filter((r) => r.exp > input.now);
  if (input.select) {
    const r = live.find((x) => x.id === input.select);
    if (!r) return refuse("That request is no longer pending.");
    return { ok: true, base: { act: r.act, res: r.res, aud: r.aud, request: r } };
  }
  const candidates = live.filter((r) => fitsAnchors(r, a));
  let chosen: Request | undefined;
  if (input.draftRequest !== undefined) {
    chosen = candidates.find((r) => r.id === input.draftRequest);
    if (!chosen) {
      beyond.push({ field: "request", asked: input.draftRequest, why: "your words don't point at that request" });
    }
  }
  const specific = a.acts.length + a.prNumbers.length + a.repos.length + a.sites.length + a.envs.length + a.shas.length + a.named.length > 0;
  if (!chosen && candidates.length === 1 && (specific || a.approves)) chosen = candidates[0];
  if (!chosen && candidates.length > 1) {
    return question("Which request do you mean?", candidates.map(describeRequest));
  }
  if (chosen) {
    if (a.negatedActs.includes(chosen.act)) return refuse(`You said not to ${CATALOG[chosen.act]?.verb ?? chosen.act}.`);
    return { ok: true, base: { act: chosen.act, res: chosen.res, aud: chosen.aud, request: chosen } };
  }

  // No pending request fits: a pre-approval, bound from the words alone.
  if (a.acts.length === 0) {
    if (live.length) return refuse("Your words don't match any pending request.");
    return question("What should I approve? Nothing is pending.", []);
  }
  let act: string;
  if (a.acts.length > 1) {
    if (input.draftAct && a.acts.includes(input.draftAct)) {
      act = input.draftAct;
      for (const other of a.acts.filter((x) => x !== act)) {
        beyond.push({ field: "act", asked: other, why: "one action per grant; ask again for this one" });
      }
    } else {
      return question("Which should I approve first? One action per grant.", a.acts.map((x) => CATALOG[x]?.verb ?? x));
    }
  } else {
    act = a.acts[0]!;
  }
  if (!CATALOG[act]) return refuse(`${act} is not an action okayed knows.`);
  const res = bindFromWords(act, a, input.targets);
  if (!res.ok) return res;

  let aud: string | undefined;
  if (a.agents.length === 1) aud = a.agents[0];
  else if (a.agents.length > 1) return question("Which agent?", a.agents);
  else if (input.targets.agents.length === 1) aud = input.targets.agents[0];
  if (!aud) return question("Which agent is this for?", input.targets.agents);
  return { ok: true, base: { act, res: res.res, aud, request: null } };
}

