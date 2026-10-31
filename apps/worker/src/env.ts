import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { OkayedAgent } from "./agent.ts";
import type { OkayedChat } from "./chat.ts";
import type { OkayedDirectory } from "./directory.ts";
import type { OkayedMcp } from "./mcp.ts";
import type { WakeMessage } from "./notify.ts";

/** Everything the Worker can be given. Only the Durable Objects, the Workflow and ISSUER_SECRET are required. */
export interface Env {
  AI?: Ai;
  OkayedAgent: DurableObjectNamespace<OkayedAgent>;
  OkayedChat: DurableObjectNamespace<OkayedChat>;
  OkayedMcp: DurableObjectNamespace<OkayedMcp>;
  OkayedDirectory: DurableObjectNamespace<OkayedDirectory>;
  GRANT_LIFECYCLE: Workflow;
  ISSUER_SECRET: string;
  /** The web app, the playground and the shadcn registry (Workers Static Assets). */
  ASSETS?: Fetcher;
  /** OAuth for remote MCP clients: its storage, and the helpers the library injects. */
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;

  /** Comma-separated origins the web app is served from, besides the Worker's own; passkeys are bound to them. */
  WEB_ORIGINS?: string;
  /** "0" turns off the demo's starting repos and sites. */
  DEMO?: string;
  GITHUB_TOKEN?: string;

  /** "workers-ai" (default), "openai-compatible" or "heuristic". */
  DRAFTER?: string;
  MODEL?: string;
  /** For DRAFTER=openai-compatible: the endpoint up to /v1, and its key (a secret). */
  DRAFT_BASE_URL?: string;
  DRAFT_API_KEY?: string;
  /** An AI Gateway id: Workers AI calls go through it for logs, caching and rate limits. */
  AI_GATEWAY?: string;

  /** Cloudflare Access: the team name (<team>.cloudflareaccess.com) and the application's AUD tag. */
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
  /** Any other OIDC provider whose ID token, sent as the bearer token, stands in for the owner token. */
  OIDC_ISSUER?: string;
  OIDC_AUDIENCE?: string;
  /** A GitHub App for merges: tokens minted per call for one repository (preferred over GITHUB_TOKEN). */
  GITHUB_APP_ID?: string;
  GITHUB_APP_KEY?: string;
  GITHUB_APP_INSTALLATION?: string;
  /** Turnstile on account creation. */
  TURNSTILE_SECRET?: string;
  /** Workers rate limiting: sign-ups per address, requests per agent, model calls (chat and voice) per person. */
  SIGNUP_LIMIT?: RateLimit;
  AGENT_LIMIT?: RateLimit;
  CHAT_LIMIT?: RateLimit;
  /** Workers Analytics Engine: one data point per decision. */
  METRICS?: AnalyticsEngineDataset;
  /** Queues: wakes paired approver apps. */
  APPROVER_WAKE?: Queue<WakeMessage>;
  /** R2: an archive of every signed event. Needs R2 enabled on the account. */
  ARCHIVE?: R2Bucket;

  /** Capability packs to approve beyond the built-in ones: example ids ("slack,email") and your own as JSON. */
  CAPABILITY_PACKS?: string;
  CAPABILITY_PACKS_JSON?: string;
  /** Slack posts (the slack pack): a bot token and its workspace. */
  SLACK_BOT_TOKEN?: string;
  SLACK_WORKSPACE?: string;
  /** DNS changes (the cloudflare-dns pack): zone name → zone id, with CF_ACCOUNT_ID and CF_API_TOKEN. */
  CF_DNS_ZONES?: string;
  /** Real deploys: the account, a token that can create account tokens, and which Pages project each site is. */
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  CF_PAGES_SITES?: string;
  CF_PAGES_WRITE_GROUP?: string;

  /** An organization's policy (JSON, see @okayed/interop's OrgPolicy): what its groups' agents may do. */
  ORG_POLICY?: string;
  /** SCIM provisioning at /scim/v2: the bearer token the identity provider is set up with (a secret). */
  SCIM_TOKEN?: string;
  /** Which SCIM attribute holds the subject people's sign-in tokens carry: externalId (default), userName or id. */
  SCIM_SUBJECT?: string;
}
