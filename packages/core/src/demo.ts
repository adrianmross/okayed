import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { CATALOG, extractAnchors, humanDuration, labelRes, type Targets } from "@okayed/engine";
import { sha256Hex, type Grant, type NostrEvent } from "@okayed/grant";
import { tool, type ToolApprovalConfiguration, type ToolSet } from "ai";
import { z } from "zod";

/**
 * The demo assistant: a chat agent whose tools ask okayed before they "act". Nothing real happens: each tool
 * returns what it would have done and the receipt for the grant it used. The assistant is the agent `agent:assistant`.
 */

export const DEMO_AGENT = "agent:assistant";
export const DEMO_OWNER = "adrianmross";

/** The demo's world, so words like "okayed" and "openmeadow" bind to exact targets. */
export const DEMO_TARGETS: Targets = {
  repos: ["adrianmross/okayed", "adrianmross/matrix", "adrianmross/pump"],
  prs: [],
  sites: [
    { host: "openmeadow.org", envs: ["production", "staging", "preview"] },
    { host: "buzz.dev", envs: ["production", "staging"] },
  ],
  agents: [DEMO_AGENT],
};

/** What the tools need from okayed, so the same tools run on Cloudflare and in tests. */
export interface DemoBackend {
  request(input: { act: string; res: string[]; why: string; ref: string }): Promise<{ status: "pending" | "approving" | "granted" | "denied" | "expired"; reason?: string; cardId?: string }>;
  byRef(ref: string): Promise<{ status: "pending" | "granted" | "denied" | "expired"; reason?: string; grant?: NostrEvent } | null>;
  use(event: NostrEvent, act: string, res: string): Promise<{ ok: true; left: number; receipt?: NostrEvent } | { ok: false; reason: string }>;
  proposePolicy(sentence: string): Promise<{ cardId: string; kind: string; sentence: string }>;
}

/** A stand-in head commit for a PR, stable per repo and number. */
export function demoHead(repo: string, number: number): string {
  return sha256Hex(`${repo}#${number}`).slice(0, 40);
}

const repoOf = (r: string) => (r.includes("/") ? r : `${DEMO_OWNER}/${r}`).toLowerCase();

// Each tool's input type differs; the table is read through this erased view.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySpec = Spec<any>;

interface Spec<I> {
  description: string;
  input: z.ZodType<I>;
  act: string;
  res: (i: I) => string;
  why: (i: I) => string;
  done: (i: I) => string;
}

const SPECS = {
  read_repository: {
    description: "Read a GitHub repository (files, issues, pull requests).",
    input: z.object({ repo: z.string().describe("owner/name, e.g. adrianmross/okayed") }),
    act: "github.read",
    res: (i: { repo: string }) => `github:${repoOf(i.repo)}`,
    why: (i: { repo: string }) => `to read ${repoOf(i.repo)}`,
    done: (i: { repo: string }) => `Read ${repoOf(i.repo)}: 12 open issues, 3 open pull requests.`,
  } satisfies Spec<{ repo: string }>,
  comment_on_pull_request: {
    description: "Post a comment on a GitHub pull request.",
    input: z.object({ repo: z.string(), number: z.number().int().positive(), comment: z.string().max(500) }),
    act: "github.pr.comment",
    res: (i: { repo: string; number: number }) => `github:${repoOf(i.repo)}/pull/${i.number}`,
    why: (i: { comment: string }) => `to comment: ${i.comment.slice(0, 80)}`,
    done: (i: { repo: string; number: number }) => `Commented on PR #${i.number} in ${repoOf(i.repo)}.`,
  } satisfies Spec<{ repo: string; number: number; comment: string }>,
  merge_pull_request: {
    description: "Merge a GitHub pull request at its current head commit.",
    input: z.object({ repo: z.string(), number: z.number().int().positive() }),
    act: "github.pr.merge",
    res: (i: { repo: string; number: number }) => `github:${repoOf(i.repo)}/pull/${i.number}@${demoHead(repoOf(i.repo), i.number)}`,
    why: (i: { number: number }) => `checks are green on #${i.number}`,
    done: (i: { repo: string; number: number }) => `Merged PR #${i.number} into ${repoOf(i.repo)} at ${demoHead(repoOf(i.repo), i.number).slice(0, 7)}.`,
  } satisfies Spec<{ repo: string; number: number }>,
  deploy_site: {
    description: "Deploy a website to an environment.",
    input: z.object({ site: z.string().describe("host, e.g. openmeadow.org"), environment: z.enum(["production", "staging", "preview"]) }),
    act: "site.deploy",
    res: (i: { site: string; environment: string }) => `site:${i.site.toLowerCase()}/${i.environment}`,
    why: (i: { environment: string }) => `ship the latest build to ${i.environment}`,
    done: (i: { site: string; environment: string }) => `Deployed ${i.site} to ${i.environment}.`,
  } satisfies Spec<{ site: string; environment: string }>,
  buy: {
    description: "Buy something with the saved card, up to an amount in US dollars.",
    input: z.object({ item: z.string(), amount_usd: z.number().positive().max(10000) }),
    act: "spend.money",
    res: (i: { amount_usd: number }) => `money:card-1/USD/${Math.ceil(i.amount_usd)}`,
    why: (i: { item: string }) => `to buy ${i.item}`,
    done: (i: { item: string; amount_usd: number }) => `Bought ${i.item} for $${i.amount_usd}.`,
  } satisfies Spec<{ item: string; amount_usd: number }>,
};

type SpecName = keyof typeof SPECS;
const isSpec = (n: string): n is SpecName => n in SPECS;

async function waitForGrant(b: DemoBackend, ref: string, seconds: number) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const st = await b.byRef(ref);
    if (!st || st.status !== "pending" || Date.now() >= until) return st;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** The tools, and the approval rule that hands every call to okayed. */
export function demoTools(b: DemoBackend): { tools: ToolSet; toolApproval: ToolApprovalConfiguration<ToolSet, unknown> } {
  const tools: ToolSet = {};
  for (const [name, spec] of Object.entries(SPECS) as unknown as [SpecName, AnySpec][]) {
    tools[name] = tool({
      description: `${spec.description} Simulated: nothing real happens. okayed decides whether it may run.`,
      inputSchema: spec.input,
      execute: async (input: unknown, { toolCallId }) => {
        // The approval the chat recorded isn't trusted on its own: the grant must exist, and using it spends it.
        const st = await waitForGrant(b, toolCallId, 10);
        if (!st || st.status !== "granted" || !st.grant) return { done: false, reason: st?.reason ?? "there is no grant for this" };
        const g = JSON.parse(st.grant.content) as Grant;
        const used = await b.use(st.grant, spec.act, spec.res(input));
        if (!used.ok) return { done: false, reason: used.reason };
        return {
          done: true,
          simulated: true,
          summary: spec.done(input),
          grant: g.id,
          approvedBy: g.assurance.method === "policy" ? `your rules (${(g.assurance.policy ?? []).join(", ")})` : g.assurance.method === "webauthn" ? "you, with Face ID" : "you",
          receipt: used.receipt?.id,
          left: used.left,
        };
      },
    });
  }
  tools.propose_policy = tool({
    description: "Suggest a rule in the person's words, e.g. 'always allow merges in okayed for 2 weeks'. The person reviews and adds it; you can't change their rules yourself.",
    inputSchema: z.object({ sentence: z.string().max(400) }),
    execute: async ({ sentence }: { sentence: string }) => {
      const card = await b.proposePolicy(sentence);
      return { proposed: card.kind === "policy", card: card.cardId, summary: card.sentence };
    },
  });

  const toolApproval: ToolApprovalConfiguration<ToolSet, unknown> = async ({ toolCall }) => {
    if (!isSpec(toolCall.toolName)) return "not-applicable";
    const spec = SPECS[toolCall.toolName] as unknown as AnySpec;
    const parsed = spec.input.safeParse(toolCall.input);
    if (!parsed.success) return { type: "denied", reason: "the request wasn't well formed" };
    const r = await b.request({ act: spec.act, res: [spec.res(parsed.data)], why: spec.why(parsed.data), ref: toolCall.toolCallId });
    if (r.status === "approving" || r.status === "granted") return { type: "approved", reason: "your rules allow this" };
    if (r.status === "pending") return { type: "user-approval", reason: "okayed is asking you" };
    return { type: "denied", reason: r.reason ?? "okayed refused this" };
  };
  return { tools, toolApproval };
}

export const DEMO_SYSTEM = `You are a helpful engineering assistant in a demo of okayed, a service that turns a person's okay into an exact, signed, expiring permission.
You can read repositories, comment on and merge pull requests, deploy sites and buy things, but only through your tools. Every tool call is checked by okayed: the person's rules may allow it, ask the person (who allows it with Face ID), or block it. All actions are simulated; say so briefly when you report a result.
Rules: use a tool whenever the person asks you to do something; never claim something happened unless the tool result says done: true; if a tool was refused or not approved, say so plainly and don't retry. Repos default to owner adrianmross. Keep replies to one or two short sentences.
If the person describes a rule ("always allow merges in okayed for two weeks", "never deploy to production"), call propose_policy with their sentence.`;

// ---------- a scripted model, for running without Workers AI ----------

const POLICY_WORDS = /\b(?:auto[- ]?approve|always|never|ask me|from now on|don't ask|without asking|whenever|let (?:assistant|it|them) \w+ (?:anything|any|all|every))\b|\bup to \d+ \w+|\bfor (?:\d+|a|one|two) (?:days?|weeks?)\b/i;

function lastUserText(prompt: LanguageModelV4Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i]!;
    if (m.role === "user") return m.content.map((c) => (c.type === "text" ? c.text : "")).join(" ");
  }
  return "";
}

type Step = { text: string } | { tool: string; input: Record<string, unknown> };

/** What the scripted assistant does next: call a tool for the person's ask, or report the tool's result. */
export function scriptedStep(prompt: LanguageModelV4Prompt): Step {
  const last = prompt[prompt.length - 1];
  if (last?.role === "tool") {
    const results = last.content.filter((c) => c.type === "tool-result");
    const r = results[results.length - 1];
    if (!r) return { text: "Okay." };
    const out = r.output;
    if (out.type === "execution-denied") return { text: `Okay, I won't. ${out.reason ? `(${out.reason.replace(/\.$/, "")}.)` : ""}`.trim() };
    // Denials can also arrive as text, depending on how the transcript was converted.
    if ((out.type === "error-text" || out.type === "text") && /denied|declined|not approved|said no/i.test(out.value)) return { text: "Okay, I won't." };
    if (out.type === "error-text") return { text: `I couldn't: ${out.value}` };
    if (out.type === "json" && out.value && typeof out.value === "object") {
      const v = out.value as Record<string, unknown>;
      if (v.done === true) return { text: `Done: ${v.summary} This was simulated, allowed by ${v.approvedBy}; the permission is now used up.` };
      if (v.done === false) return { text: `I couldn't: ${v.reason}.` };
      if ("proposed" in v) return { text: v.proposed ? `Here's the rule I'd add: ${v.summary} Add it if it looks right.` : `${v.summary}` };
    }
    return { text: "That didn't work." };
  }
  const said = lastUserText(prompt);
  const t = said.toLowerCase();
  if (POLICY_WORDS.test(said)) return { tool: "propose_policy", input: { sentence: said } };
  const a = extractAnchors(said, DEMO_TARGETS);
  const repo = a.repos[0] ?? "adrianmross/okayed";
  if (a.negatedActs.length && !a.acts.length) return { text: "Got it, I won't." };
  if (a.acts.includes("github.pr.merge")) {
    const n = a.prNumbers[0];
    return n ? { tool: "merge_pull_request", input: { repo, number: n } } : { text: `Which pull request in ${repo} should I merge?` };
  }
  if (a.acts.includes("github.pr.comment")) {
    const n = a.prNumbers[0];
    const body = /(?:saying|that says|:)\s*["“]?([^"”]+)["”]?$/i.exec(said)?.[1] ?? "Looks good to me.";
    return n ? { tool: "comment_on_pull_request", input: { repo, number: n, comment: body } } : { text: "Which pull request should I comment on?" };
  }
  if (a.acts.includes("site.deploy")) {
    const site = a.sites[0] ?? "openmeadow.org";
    const env = a.envs[0];
    return env ? { tool: "deploy_site", input: { site, environment: env } } : { text: `Deploy ${site} to production, staging or preview?` };
  }
  if (a.acts.includes("spend.money")) {
    const amount = Number(/\$\s?(\d+(?:\.\d+)?)/.exec(said)?.[1] ?? /(\d+(?:\.\d+)?)\s?(?:usd|dollars)/i.exec(said)?.[1]);
    const item = /\bbuy\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(.+?)(?:\s+for\s+\$?\d.*)?$/i.exec(said)?.[1] ?? "it";
    return amount > 0 ? { tool: "buy", input: { item, amount_usd: amount } } : { text: "How much may I spend?" };
  }
  if (a.acts.includes("github.read")) return { tool: "read_repository", input: { repo } };
  if (/\b(hi|hello|hey|help|what can you)\b/.test(t)) {
    return { text: "Hi! Ask me to merge a pull request, deploy a site, comment, or buy something. Your rules decide whether each one is allowed, asks you, or is blocked." };
  }
  return { text: "I can read repos, comment on and merge pull requests, deploy sites, and buy things. Each one goes through okayed first. What should I do?" };
}

const ZERO_USAGE = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } };

/** A deterministic stand-in for the language model: reads intent with okayed's own anchors, no network needed. */
export function scriptedModel(): LanguageModelV4 {
  let calls = 0;
  return {
    specificationVersion: "v4",
    provider: "okayed",
    modelId: "scripted-assistant",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("the scripted model only streams");
    },
    async doStream(options: LanguageModelV4CallOptions) {
      const step = scriptedStep(options.prompt);
      const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
      if ("text" in step) {
        const id = `t${++calls}`;
        parts.push({ type: "text-start", id });
        for (const w of step.text.split(/(?<= )/)) parts.push({ type: "text-delta", id, delta: w });
        parts.push({ type: "text-end", id }, { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: "stop" } });
      } else {
        parts.push(
          { type: "tool-call", toolCallId: `call_${Date.now().toString(36)}${(++calls).toString(36)}`, toolName: step.tool, input: JSON.stringify(step.input) },
          { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
        );
      }
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async start(c) {
          for (const p of parts) {
            c.enqueue(p);
            if (p.type === "text-delta") await new Promise((r) => setTimeout(r, 12));
          }
          c.close();
        },
      });
      return { stream };
    },
  };
}

/** A one-line description of a request, for logs and transcripts. */
export function describeAsk(act: string, res: string[]): string {
  return `${CATALOG[act]?.verb ?? act} ${res.map(labelRes).join(", ")}`;
}

export { humanDuration };
