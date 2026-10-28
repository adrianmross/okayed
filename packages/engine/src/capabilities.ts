import { CATALOG, type ActionSpec, type RiskIf } from "./catalog.ts";
import { BUILTIN_KINDS, compileResourceType, registerResourceTypes, resourceType, unregisterResourceTypes, type ResourceType } from "./resource.ts";
import type { Risk } from "./types.ts";

/**
 * Capability packs: what a service can do, as data. A pack names its actions (with risk, lifetimes, use counts and the
 * words people use for them) and the resource types they act on (a template each). Registered, its actions work
 * everywhere the built-in ones do: decisions, narrowing, rules from words, explanations, risk costs and use checks.
 */

/** One action of a pack. Lifetimes in seconds; `res` lists resource kinds, the pack's own or already registered. */
export interface ActionDef {
  act: string;
  title?: string;
  /** For sentences: "post to", "send email to". */
  verb: string;
  /** For rules: "posting to Slack". */
  noun: string;
  risk: Risk;
  readOnly?: boolean;
  ttl: number;
  maxTtl: number;
  uses: number;
  maxUses: number;
  res: string[];
  /** Words or phrases that name it: "post", "message", "dns record". Each word also matches -s, -ed and -ing. */
  keywords?: string[];
  riskIf?: RiskIf[];
}

export interface CapabilityPack {
  id: string;
  title: string;
  description?: string;
  resources?: ResourceType[];
  actions: ActionDef[];
}

const MIN = 60;
const HOUR = 3600;
const RISKS: Risk[] = ["low", "medium", "high", "critical"];

/** The built-in actions, described as packs. They're always registered; their resources are parsed by hand. */
export const BUILTIN_PACKS: CapabilityPack[] = [
  {
    id: "github",
    title: "GitHub",
    resources: [
      { kind: "github.repo", template: "github:{owner}/{repo}", label: "{owner}/{repo}" },
      { kind: "github.pr", template: "github:{owner}/{repo}/pull/{number}@{sha}", label: "PR #{number} in {owner}/{repo}" },
    ],
    actions: ["github.read", "github.pr.comment", "github.pr.merge"].map((a) => specToDef(CATALOG[a]!)),
  },
  {
    id: "sites",
    title: "Sites",
    resources: [{ kind: "site", template: "site:{host}/{env}", label: "{host} ({env})" }],
    actions: [specToDef(CATALOG["site.deploy"]!)],
  },
  {
    id: "money",
    title: "Money",
    resources: [{ kind: "money", template: "money:{account}/{currency}/{max}", label: "up to {max} {currency} from {account}" }],
    actions: [specToDef(CATALOG["spend.money"]!)],
  },
];

function specToDef(s: ActionSpec): ActionDef {
  const { act, verb, noun, risk, readOnly, ttl, maxTtl, uses, maxUses, res } = s;
  return { act, verb, noun, risk, readOnly, ttl, maxTtl, uses, maxUses, res: [...res] };
}

const registered = new Map<string, CapabilityPack>();

const positive = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

/** Everything wrong with a pack, before anything is registered. */
function problems(pack: CapabilityPack): string[] {
  const out: string[] = [];
  if (!pack || typeof pack !== "object") return ["a pack must be an object"];
  if (typeof pack.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(pack.id)) out.push(`pack id "${pack.id}" must be lowercase, e.g. slack`);
  else if (registered.has(pack.id) || BUILTIN_PACKS.some((p) => p.id === pack.id)) out.push(`pack ${pack.id} is already registered`);
  if (typeof pack.title !== "string" || !pack.title.trim()) out.push(`${pack.id}: needs a title`);
  const kinds = new Set<string>();
  for (const t of pack.resources ?? []) {
    try {
      compileResourceType(t);
    } catch (e) {
      out.push((e as Error).message);
    }
    if (kinds.has(t.kind)) out.push(`${pack.id}: resource kind ${t.kind} appears twice`);
    else if (BUILTIN_KINDS.has(t.kind) || resourceType(t.kind)) out.push(`${pack.id}: resource kind ${t.kind} is already registered`);
    kinds.add(t.kind);
  }
  if (!Array.isArray(pack.actions) || !pack.actions.length) out.push(`${pack.id}: needs at least one action`);
  const acts = new Set<string>();
  for (const a of pack.actions ?? []) {
    const name = typeof a?.act === "string" ? a.act : String(a?.act);
    if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(name)) out.push(`action "${name}" must be dotted lowercase, e.g. slack.message.post`);
    if (acts.has(name)) out.push(`action ${name} appears twice`);
    else if (CATALOG[name]) out.push(`action ${name} is already registered`);
    acts.add(name);
    if (typeof a.verb !== "string" || !a.verb.trim() || typeof a.noun !== "string" || !a.noun.trim()) out.push(`${name}: needs a verb and a noun`);
    if (!RISKS.includes(a.risk)) out.push(`${name}: risk must be low, medium, high or critical`);
    if (![a.ttl, a.maxTtl, a.uses, a.maxUses].every(positive)) out.push(`${name}: ttl, maxTtl, uses and maxUses must be whole numbers above zero`);
    else if (a.ttl > a.maxTtl || a.uses > a.maxUses) out.push(`${name}: the defaults can't exceed the maximums`);
    if (!Array.isArray(a.res) || !a.res.length) out.push(`${name}: needs the resource kinds it acts on`);
    for (const k of a.res ?? []) if (!kinds.has(k) && !BUILTIN_KINDS.has(k) && !resourceType(k)) out.push(`${name}: resource kind ${k} isn't declared`);
    for (const k of a.keywords ?? []) if (typeof k !== "string" || !/^[a-z][a-z0-9 '-]*$/.test(k)) out.push(`${name}: keyword "${k}" must be lowercase words`);
    for (const r of a.riskIf ?? []) {
      if (!RISKS.includes(r.risk) || typeof r.field !== "string") out.push(`${name}: riskIf needs a field and a risk`);
      if (r.matches !== undefined) {
        try {
          new RegExp(r.matches);
        } catch {
          out.push(`${name}: riskIf.matches isn't a valid regex`);
        }
      }
    }
  }
  return out;
}

/** Registers a pack, all or nothing. Throws with every problem when it can't be used. */
export function registerPack(pack: CapabilityPack): void {
  const wrong = problems(pack);
  if (wrong.length) throw new Error(`can't register ${pack?.id ?? "this pack"}: ${wrong.join("; ")}`);
  registerResourceTypes(pack.resources ?? []);
  for (const a of pack.actions) {
    CATALOG[a.act] = {
      act: a.act,
      res: [...a.res],
      risk: a.risk,
      readOnly: a.readOnly ?? false,
      ttl: a.ttl,
      maxTtl: a.maxTtl,
      uses: a.uses,
      maxUses: a.maxUses,
      verb: a.verb,
      noun: a.noun,
      pack: pack.id,
      ...(a.title ? { title: a.title } : {}),
      ...(a.keywords?.length ? { keywords: [...a.keywords] } : {}),
      ...(a.riskIf?.length ? { riskIf: a.riskIf.map((r) => ({ ...r })) } : {}),
    };
  }
  registered.set(pack.id, pack);
}

/** Removes a registered pack and its actions and resource types. Built-in packs stay. */
export function unregisterPack(id: string): void {
  const pack = registered.get(id);
  if (!pack) return;
  for (const a of pack.actions) delete CATALOG[a.act];
  unregisterResourceTypes((pack.resources ?? []).map((t) => t.kind));
  registered.delete(id);
}

/** Every pack in use: the built-in ones, then the registered ones in order. */
export function registeredPacks(): CapabilityPack[] {
  return [...BUILTIN_PACKS, ...registered.values()];
}

/**
 * Example packs for other services, not registered by default. Register the ones a deployment can act on, and give
 * the person's known targets of each (`Targets.named`) so words like "#releases" bind to an exact resource.
 */
export const EXAMPLE_PACKS = {
  slack: {
    id: "slack",
    title: "Slack",
    resources: [{ kind: "slack.channel", template: "slack:{workspace}/{channel}", label: "#{channel} in {workspace}" }],
    actions: [
      {
        act: "slack.message.post",
        title: "Post a message",
        verb: "post to",
        noun: "posting to Slack",
        risk: "medium",
        ttl: 30 * MIN,
        maxTtl: 4 * HOUR,
        uses: 1,
        maxUses: 20,
        res: ["slack.channel"],
        keywords: ["post", "posting", "message", "slack"],
      },
    ],
  },
  email: {
    id: "email",
    title: "Email",
    resources: [{ kind: "email.address", template: "email:{address}", label: "{address}", fields: { address: "[a-z0-9._%+-]+@[a-z0-9-]+(?:\\.[a-z0-9-]+)+" } }],
    actions: [
      {
        act: "email.send",
        title: "Send an email",
        verb: "email",
        noun: "sending email",
        risk: "medium",
        ttl: 30 * MIN,
        maxTtl: 2 * HOUR,
        uses: 1,
        maxUses: 10,
        res: ["email.address"],
        keywords: ["email", "e-mail", "mail"],
      },
    ],
  },
  cloudflareDns: {
    id: "cloudflare-dns",
    title: "Cloudflare DNS",
    resources: [{ kind: "cloudflare.dns.record", template: "dns:{zone}/{type}/{name}", label: "{type|upper} {name} in {zone}", fields: { type: "a|aaaa|cname|txt|mx|ns|srv|caa", name: "@|[a-z0-9_-]+(?:\\.[a-z0-9_-]+)*" } }],
    actions: [
      {
        act: "cloudflare.dns.edit",
        title: "Change a DNS record",
        verb: "change",
        noun: "changing DNS records",
        risk: "high",
        ttl: 15 * MIN,
        maxTtl: HOUR,
        uses: 1,
        maxUses: 5,
        res: ["cloudflare.dns.record"],
        keywords: ["dns", "dns record"],
        // The zone apex and its name servers can take a whole domain down.
        riskIf: [
          { field: "name", equals: ["@"], risk: "critical" },
          { field: "type", equals: ["ns"], risk: "critical" },
        ],
      },
    ],
  },
  awsS3: {
    id: "aws-s3",
    title: "Amazon S3",
    // Object keys are case-sensitive, so the type keeps case as written.
    resources: [{ kind: "aws.s3.object", template: "s3:{bucket}/{key}", label: "{key} in {bucket}", caseSensitive: true, fields: { bucket: "[a-z0-9][a-z0-9.-]{1,62}", key: "[A-Za-z0-9!_.'()-]+(?:/[A-Za-z0-9!_.'()-]+)*" }, ruleScope: "s3:{bucket}/**" }],
    actions: [
      {
        act: "aws.s3.put",
        title: "Write an object",
        verb: "write",
        noun: "writing to S3",
        risk: "medium",
        ttl: 30 * MIN,
        maxTtl: 12 * HOUR,
        uses: 1,
        maxUses: 1000,
        res: ["aws.s3.object"],
        keywords: ["upload", "s3"],
        riskIf: [{ field: "bucket", matches: "prod", risk: "high" }],
      },
    ],
  },
} satisfies Record<string, CapabilityPack>;
