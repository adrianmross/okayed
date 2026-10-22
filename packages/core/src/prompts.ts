import { CATALOG } from "@okayed/engine";
import type { DraftContext } from "./ports.ts";

/**
 * Provider-neutral prompts. Any chat model that can return JSON can draft with these; the engine treats the
 * output as untrusted either way.
 */

export const DRAFT_SYSTEM = `You draft approvals for okayed, a service that turns a person's plain-language okay into a narrow, exact, expiring grant for an AI agent.
You only draft. A deterministic engine checks your draft, cuts anything broader than what the person said, and the person confirms. Never try to widen scope: drafts broader than the person's words are refused and shown to them.

Classify the person's message:
- "grant": they approve or pre-approve one specific action (e.g. "I approve merging #182", "go ahead and deploy the website to staging").
- "policy": they set a standing rule (e.g. "auto-approve read-only GitHub for 1 hour", "ask me before anything that spends money", "never deploy on Fridays").
- "other": anything else (a question, small talk). Reply briefly.

For "grant", fill only what the person said or what a pending request clearly says:
- request: the id of the pending request they mean, if any.
- act: exactly one action from the catalog.
- res: exact resources. GitHub PR: "github:<owner>/<repo>/pull/<n>@<40-hex sha>". Repo: "github:<owner>/<repo>". Site: "site:<host>/<env>". Never use "*".
- ttl: seconds, only if they said a duration. uses: only if they said a count ("once" = 1).
- when: [{"c":"checks.pass"}] only if they said "once CI passes" or similar.
For "policy", give rules: effect ("allow" = auto-approve, "ask" = ask the person, "deny" = never), act (a catalog action, or a prefix like "github.*"), optional res pattern, optional ttl in seconds for how long an auto-approval lasts.

Return JSON only, matching the schema.`;

export function draftUser(utterance: string, ctx: DraftContext): string {
  const catalog = Object.values(CATALOG)
    .map((a) => `${a.act} (${a.verb}; resources: ${a.res.join(", ")}; risk ${a.risk})`)
    .join("\n");
  const pending = ctx.pending.length
    ? ctx.pending.map((p) => `- ${p.id}: ${p.sentence} [act ${p.act}; res ${p.res.join(", ")}]`).join("\n")
    : "(none)";
  return `Catalog:
${catalog}

Known repositories: ${ctx.targets.repos.join(", ") || "(none)"}
Known sites: ${ctx.targets.sites.map((s) => `${s.host} [${s.envs.join(", ")}]`).join("; ") || "(none)"}
Agents: ${ctx.targets.agents.join(", ") || "(none)"}
Pending requests:
${pending}

The person said: """${utterance.slice(0, 2000)}"""`;
}

export const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["grant", "policy", "other"] },
    reply: { type: "string" },
    grant: {
      type: "object",
      properties: {
        request: { type: "string" },
        act: { type: "string" },
        res: { type: "array", items: { type: "string" } },
        ttl: { type: "integer" },
        uses: { type: "integer" },
        when: { type: "array", items: { type: "object", properties: { c: { type: "string" } }, required: ["c"] } },
      },
    },
    policy: {
      type: "object",
      properties: {
        rules: {
          type: "array",
          items: {
            type: "object",
            properties: {
              effect: { type: "string", enum: ["allow", "ask", "deny"] },
              act: { type: "string" },
              res: { type: "string" },
              ttl: { type: "integer" },
            },
            required: ["effect", "act"],
          },
        },
      },
    },
  },
  required: ["intent"],
} as const;

export const EXPLAIN_SYSTEM = `You explain okayed approvals to a busy person in one or two short, plain sentences. Use only the facts given. Do not add permissions, reassure, or speculate. Mention risk if it is high or critical. No preamble.`;
