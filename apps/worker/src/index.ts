import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { app } from "./api.ts";
import type { Env } from "./env.ts";
import { OkayedMcp } from "./mcp.ts";
import { wake, type WakeMessage } from "./notify.ts";

export { OkayedAgent } from "./agent.ts";
export { OkayedChat } from "./chat.ts";
export { OkayedMcp } from "./mcp.ts";
export { GrantLifecycle } from "./workflow.ts";

/**
 * The Worker: OAuth for remote MCP clients wraps everything. /mcp needs an access token; the rest is the API, the
 * live sockets and the web app (`app`). A queue consumer wakes paired approver apps.
 */
const providers = new Map<string, OAuthProvider<Env>>();

/** One provider per origin the Worker is reached at (workers.dev, a custom domain, localhost): /mcp is its resource. */
function provider(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiHandlers: { "/mcp": OkayedMcp.serve("/mcp", { binding: "OkayedMcp" }) as never },
      defaultHandler: app as never,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["okayed"],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: "okayed" },
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => provider(new URL(req.url).origin).fetch(req, env, ctx),
  queue: (batch: MessageBatch<WakeMessage>) => wake(batch),
} satisfies ExportedHandler<Env, WakeMessage>;
