import type { OkayedAgent } from "./agent.ts";

export interface Env {
  AI: Ai;
  OkayedAgent: DurableObjectNamespace<OkayedAgent>;
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
    }
  }
}
