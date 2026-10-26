import type { OkayedAgent } from "./agent.ts";
import type { OkayedChat } from "./chat.ts";

export interface Env {
  AI: Ai;
  OkayedAgent: DurableObjectNamespace<OkayedAgent>;
  OkayedChat: DurableObjectNamespace<OkayedChat>;
  /** Comma-separated origins the web app is served from; passkeys are bound to them. */
  WEB_ORIGINS?: string;
  /** "0" turns off the demo's starting repos and sites. */
  DEMO?: string;
  GRANT_LIFECYCLE: Workflow;
  ISSUER_SECRET: string;
  GITHUB_TOKEN?: string;
  /** "workers-ai" (default), "openai-compatible" or "heuristic". */
  DRAFTER?: string;
  MODEL?: string;
  /** For DRAFTER=openai-compatible: the endpoint up to /v1, and its key (a secret). */
  DRAFT_BASE_URL?: string;
  DRAFT_API_KEY?: string;
}

declare global {
  namespace Cloudflare {
    interface Env {
      AI: Ai;
      GRANT_LIFECYCLE: Workflow;
      ISSUER_SECRET: string;
      GITHUB_TOKEN?: string;
      DRAFTER?: string;
      MODEL?: string;
      DRAFT_BASE_URL?: string;
      DRAFT_API_KEY?: string;
      WEB_ORIGINS?: string;
      DEMO?: string;
    }
  }
}
