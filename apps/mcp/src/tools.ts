import { prResource, type Answer, type NostrEvent, type OkayedClient } from "@okayed/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** What the tools need from the client: just enough to fake in tests. */
export type Client = Pick<OkayedClient, "ask" | "waitFor" | "status" | "merge" | "deploy">;

const ACTIONS = `Actions and their exact resources:
- github.read        github:<owner>/<repo>
- github.pr.comment  github:<owner>/<repo>/pull/<n>
- github.pr.merge    github:<owner>/<repo>/pull/<n>@<40-hex head sha>
- site.deploy        site:<host>/<env>            (env: production, staging, preview)
- spend.money        money:<account>/<CUR>/<max>   (e.g. money:card-1/USD/20)
Ask for exactly what you are about to do; okayed never grants wildcards.`;

function say(a: Answer): string {
  if (a.status === "granted" && a.grant) {
    const g = a.grant;
    const how = g.assurance.method === "policy" ? `by standing policy ${g.assurance.policy?.join(", ") || ""}`.trim() : `by the person (${g.assurance.method})`;
    const only = g.when.length ? ` Only if: ${g.when.map((w) => w.c).join(", ")}.` : "";
    return `Granted ${how}: ${g.act} on ${g.res.join(", ")}, ${g.uses === 1 ? "once" : `${g.uses} uses`}, until ${new Date(g.exp * 1000).toISOString()}.${only} Request ${a.request}.`;
  }
  if (a.status === "pending") return `Waiting for the person to decide (request ${a.request}). Call okayed_status with this id to keep waiting; don't act until it is granted.`;
  return `${a.status === "denied" ? "Refused" : "Expired"} (request ${a.request})${a.reason ? `: ${a.reason.replace(/\.$/, "")}` : ""}. Don't do it.`;
}

/**
 * Registers okayed's tools on an MCP server. Grants stay inside this process: the agent sees what it may do, never
 * a credential, and `okayed_merge_pr` hands the grant to okayed's own merge tool.
 */
export function registerTools(server: McpServer, client: Client): void {
  const grants = new Map<string, NostrEvent>();
  const keep = (a: Answer) => {
    if (a.event && a.grant) for (const r of a.grant.res) grants.set(r, a.event);
    return a;
  };
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

  server.registerTool(
    "okayed_actions",
    { title: "What okayed can approve", description: "Lists the actions okayed knows and how to name exact resources. Read this before okayed_request." },
    async () => text(ACTIONS),
  );

  server.registerTool(
    "okayed_request",
    {
      title: "Ask before acting",
      description:
        "Ask the person (or their rules) for permission to do one exact thing. Call this before any merge, deploy, comment or spend. Returns at once if one of their rules allows it; otherwise waits up to wait_seconds for the person.",
      inputSchema: {
        action: z.string().describe("e.g. github.pr.merge"),
        resources: z.array(z.string()).min(1).max(10).describe("exact resources, see okayed_actions"),
        why: z.string().max(280).describe("one sentence the person will read"),
        wait_seconds: z.number().int().min(0).max(600).optional(),
      },
    },
    async ({ action, resources, why, wait_seconds }) => text(say(keep(await client.ask(action, resources, why, wait_seconds ?? 60)))),
  );

  server.registerTool(
    "okayed_status",
    {
      title: "Check a request",
      description: "Checks a request filed with okayed_request, waiting up to wait_seconds for the person to decide.",
      inputSchema: { request_id: z.string(), wait_seconds: z.number().int().min(0).max(600).optional() },
    },
    async ({ request_id, wait_seconds }) => text(say(keep(await client.waitFor(request_id, wait_seconds ?? 60)))),
  );

  server.registerTool(
    "okayed_merge_pr",
    {
      title: "Merge a pull request under a grant",
      description:
        "Merges a PR through okayed, which checks and spends your grant and merges with its own GitHub token, pinned to the commit. Ask with okayed_request first (action github.pr.merge, resource github:<owner>/<repo>/pull/<n>@<sha>).",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        number: z.number().int().positive(),
        sha: z.string().regex(/^[0-9a-fA-F]{40}$/),
        method: z.enum(["merge", "squash", "rebase"]).optional(),
      },
    },
    async ({ owner, repo, number, sha, method }) => {
      const res = prResource(owner, repo, number, sha);
      const event = grants.get(res);
      if (!event) return text(`No grant for ${res} in this session. Ask first with okayed_request.`);
      try {
        const out = await client.merge(event, { owner, repo, number, sha, ...(method ? { method } : {}) });
        grants.delete(res);
        return text(`Merged ${owner}/${repo}#${number} as ${out.sha}. The grant has ${out.left} use(s) left.`);
      } catch (e) {
        return { ...text(`Not merged: ${(e as Error).message}`), isError: true };
      }
    },
  );

  server.registerTool(
    "okayed_deploy_site",
    {
      title: "Deploy a site under a grant",
      description:
        "Deploys a site environment through okayed, which checks and spends your grant, then deploys on Cloudflare Pages with a token minted for this one deploy. Ask with okayed_request first (action site.deploy, resource site:<host>/<env>).",
      inputSchema: { site: z.string().describe("e.g. okayed.dev"), env: z.string().describe("e.g. production") },
    },
    async ({ site, env }) => {
      const res = `site:${site}/${env}`;
      const event = grants.get(res);
      if (!event) return text(`No grant for ${res} in this session. Ask first with okayed_request.`);
      try {
        const out = await client.deploy(event, { site, env });
        grants.delete(res);
        return text(`Deployed ${site} (${env}): deployment ${out.id}${out.url ? ` at ${out.url}` : ""}. The grant has ${out.left} use(s) left.`);
      } catch (e) {
        return { ...text(`Not deployed: ${(e as Error).message}`), isError: true };
      }
    },
  );
}
