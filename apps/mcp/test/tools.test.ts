import { describe, expect, it } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prResource, type Answer } from "@okayed/client";
import { registerTools, type Client } from "../src/tools.ts";

const SHA = "3f9a1c2e4b5d6f708192a3b4c5d6e7f801234567";
const RES = prResource("adrianmross", "okayed", 182, SHA);
const grant = { id: "g", act: "github.pr.merge", res: [RES], aud: "agent:assistant", exp: 1761736500, uses: 1, when: [{ c: "checks.pass" }], assurance: { method: "policy", at: 1, policy: ["posture:merge"] } };
const event = { id: "e", pubkey: "p", kind: 4841, created_at: 1, tags: [], content: JSON.stringify(grant), sig: "s" };

async function connect(client: Client) {
  const server = new McpServer({ name: "okayed", version: "test" });
  registerTools(server, client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new McpClient({ name: "test", version: "1" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0]!.text, isError: !!r.isError };
  };
  return { mcp, call };
}

function fakeClient(answers: Answer[], merged: string[] = []): Client {
  return {
    ask: async () => answers.shift()!,
    waitFor: async () => answers.shift()!,
    status: async () => answers.shift()!,
    merge: async (_e, pr) => (merged.push(`${pr.owner}/${pr.repo}#${pr.number}`), { merged: true as const, sha: "m1", left: 0 }),
    deploy: async (_e, t) => (merged.push(`${t.site}/${t.env}`), { deployed: true as const, id: "dep-1", url: "https://abc.pages.dev", left: 0 }),
  };
}

describe("okayed MCP tools", () => {
  it("lists the five tools", async () => {
    const { mcp } = await connect(fakeClient([]));
    expect((await mcp.listTools()).tools.map((t) => t.name).sort()).toEqual(["okayed_actions", "okayed_deploy_site", "okayed_merge_pr", "okayed_request", "okayed_status"]);
  });

  it("deploys through okayed with a grant for that exact site and environment, once", async () => {
    const done: string[] = [];
    const deployGrant = { ...grant, act: "site.deploy", res: ["site:okayed.dev/production"], when: [] };
    const { call } = await connect(fakeClient([{ request: "r_9", status: "granted", grant: deployGrant, event }], done));
    await call("okayed_request", { action: "site.deploy", resources: ["site:okayed.dev/production"], why: "ship" });
    expect((await call("okayed_deploy_site", { site: "okayed.dev", env: "staging" })).text).toMatch(/No grant for site:okayed.dev\/staging/);
    expect((await call("okayed_deploy_site", { site: "okayed.dev", env: "production" })).text).toBe("Deployed okayed.dev (production): deployment dep-1 at https://abc.pages.dev. The grant has 0 use(s) left.");
    expect(done).toEqual(["okayed.dev/production"]);
    expect((await call("okayed_deploy_site", { site: "okayed.dev", env: "production" })).text).toMatch(/Ask first/);
  });

  it("asks, reports a standing-policy grant, and merges with it without exposing it", async () => {
    const merged: string[] = [];
    const { call } = await connect(fakeClient([{ request: "r_1", status: "granted", grant, event }], merged));
    const asked = await call("okayed_request", { action: "github.pr.merge", resources: [RES], why: "CI green" });
    expect(asked.text).toMatch(/^Granted by standing policy posture:merge: github.pr.merge .* once, .* Only if: checks.pass/);
    expect(asked.text).not.toMatch(/"sig"/);
    const m = await call("okayed_merge_pr", { owner: "adrianmross", repo: "okayed", number: 182, sha: SHA });
    expect(m.text).toBe("Merged adrianmross/okayed#182 as m1. The grant has 0 use(s) left.");
    expect(merged).toEqual(["adrianmross/okayed#182"]);
    // The grant is spent and forgotten: a second merge needs a new request.
    expect((await call("okayed_merge_pr", { owner: "adrianmross", repo: "okayed", number: 182, sha: SHA })).text).toMatch(/Ask first/);
  });

  it("tells the agent to wait, then not to act on a refusal", async () => {
    const { call } = await connect(fakeClient([{ request: "r_2", status: "pending" }, { request: "r_2", status: "denied", reason: "You declined." }]));
    expect((await call("okayed_request", { action: "site.deploy", resources: ["site:openmeadow.org/production"], why: "ship" })).text).toMatch(/Waiting .* don't act/);
    expect((await call("okayed_status", { request_id: "r_2" })).text).toBe("Refused (request r_2): You declined. Don't do it.");
  });

  it("refuses to merge without a grant for that exact commit", async () => {
    const { call } = await connect(fakeClient([{ request: "r_3", status: "granted", grant, event }]));
    await call("okayed_request", { action: "github.pr.merge", resources: [RES], why: "x" });
    const other = "aaaa1c2e4b5d6f708192a3b4c5d6e7f801234567";
    expect((await call("okayed_merge_pr", { owner: "adrianmross", repo: "okayed", number: 182, sha: other })).text).toMatch(/No grant for .*@aaaa/);
  });
});
