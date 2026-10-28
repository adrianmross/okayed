#!/usr/bin/env node
// okayed on Node: node apps/node/src/main.ts (Node 22.18+ runs the TypeScript as is).
// OKAYED_SECRET (64 hex) is required. Optional: PORT, OKAYED_DB (a SQLite file), WEB_ORIGINS, OIDC_ISSUER and
// OIDC_AUDIENCE, DRAFT_BASE_URL with MODEL and DRAFT_API_KEY, CAPABILITY_PACKS (e.g. "slack,email"), GITHUB_TOKEN,
// SLACK_BOT_TOKEN with SLACK_WORKSPACE, and CF_ACCOUNT_ID, CF_API_TOKEN with CF_PAGES_SITES or CF_DNS_ZONES.

import { okayedServer } from "./server.ts";

const env = process.env;
const server = okayedServer({
  secret: env.OKAYED_SECRET ?? "",
  db: env.OKAYED_DB ?? "okayed.sqlite",
  origins: (env.WEB_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ...(env.OIDC_ISSUER && env.OIDC_AUDIENCE ? { oidc: { issuer: env.OIDC_ISSUER, audience: env.OIDC_AUDIENCE } } : {}),
  ...(env.DRAFT_BASE_URL && env.MODEL ? { model: { baseUrl: env.DRAFT_BASE_URL, model: env.MODEL, ...(env.DRAFT_API_KEY ? { apiKey: env.DRAFT_API_KEY } : {}) } } : {}),
  env,
});
const port = Number(env.PORT ?? 8788);
server.listen(port, () => console.log(`okayed on Node: http://localhost:${port}/api`));
