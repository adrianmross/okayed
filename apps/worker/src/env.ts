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
  DRAFTER?: string;
  MODEL?: string;
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
      WEB_ORIGINS?: string;
      DEMO?: string;
    }
  }
}
