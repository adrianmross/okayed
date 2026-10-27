import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OkayedClient } from "@okayed/client";
import { registerTools } from "@okayed/mcp/tools";
import { McpAgent } from "agents/mcp";
import { app } from "./api.ts";
import type { McpProps } from "./consent.ts";
import type { Env } from "./env.ts";

/**
 * okayed as a remote MCP server: one Durable Object per session, reached at /mcp with an OAuth token. The tools are
 * the same ones the local MCP server registers; their client calls this Worker's own API in-process, as the agent
 * the person approved, so grants stay here and the agent never holds a credential.
 */
export class OkayedMcp extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer({ name: "okayed", version: "0.1.0" });

  async init(): Promise<void> {
    const props = this.props;
    if (!props) throw new Error("no OAuth props on this session");
    const client = new OkayedClient({
      api: "https://okayed.internal",
      user: props.userId,
      token: props.agentToken,
      fetch: (input, init) => app.fetch(new Request(input as RequestInfo, init), this.env),
    });
    registerTools(this.server, client);
  }
}
