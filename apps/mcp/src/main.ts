#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OkayedClient } from "@okayed/client";
import { registerTools } from "./tools.ts";

/**
 * okayed over MCP, on stdio. Configure with the person's API, user id and the agent token they minted:
 *   OKAYED_API=https://… OKAYED_USER=… OKAYED_TOKEN=agt_… okayed-mcp
 */
const { OKAYED_API, OKAYED_USER, OKAYED_TOKEN } = process.env;
if (!OKAYED_API || !OKAYED_USER || !OKAYED_TOKEN) {
  console.error("Set OKAYED_API, OKAYED_USER and OKAYED_TOKEN (an agent token from the okayed web app's Setup tab).");
  process.exit(1);
}
const server = new McpServer({ name: "okayed", version: "0.1.0" });
registerTools(server, new OkayedClient({ api: OKAYED_API, user: OKAYED_USER, token: OKAYED_TOKEN }));
await server.connect(new StdioServerTransport());
