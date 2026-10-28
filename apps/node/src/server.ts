import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { cloudflareDnsEdit, cloudflarePagesDeploy, cloudflareToken, githubMerge, slackPost, zoneScope } from "@okayed/connectors";
import {
  FallbackDrafter,
  HeuristicDrafter,
  InlineLifecycle,
  KeySigner,
  OkayedError,
  OkayedService,
  OpenAICompatibleDrafter,
  SystemClock,
  cryptoRandom,
  enablePacks,
  handleApi,
  oidcBearer,
  personOf,
  staticCredential,
  type Connector,
  type PersonIssuer,
} from "@okayed/core";
import { SqliteStore } from "./sqlite.ts";

/**
 * okayed on Node: the same core, the same HTTP API and the same tools as the Cloudflare Worker, on SQLite and
 * in-process timers. What it doesn't have is Cloudflare's: no Durable Objects (one process holds everyone), no
 * Workflows (a restart forgets pending lifecycles), no live sockets, and no demo chat.
 */
export interface NodeOptions {
  /** 64 hex characters: per-person signing keys derive from it. */
  secret: string;
  /** SQLite file, or ":memory:". */
  db?: string;
  /** Other origins the web app is served from; passkeys bind to them. */
  origins?: string[];
  /** An OIDC provider whose ID token stands in for the owner token. */
  oidc?: { issuer: string; audience: string };
  /** Drafting with any OpenAI-compatible model; the heuristic otherwise. */
  model?: { baseUrl: string; model: string; apiKey?: string };
  env?: Record<string, string | undefined>;
}

export function okayedServer(o: NodeOptions): Server {
  if (!/^[0-9a-f]{64}$/.test(o.secret)) throw new Error("the secret must be 64 hex characters");
  const db = new DatabaseSync(o.db ?? ":memory:");
  const clock = new SystemClock();
  const people = new Map<string, OkayedService>();
  const env = o.env ?? {};
  const issuers: PersonIssuer[] = o.oidc ? [oidcBearer(o.oidc.issuer, o.oidc.audience)] : [];

  enablePacks({ ids: env.CAPABILITY_PACKS, json: env.CAPABILITY_PACKS_JSON });
  const connectors: Connector<any>[] = [];
  if (env.GITHUB_TOKEN) connectors.push(githubMerge({ credential: staticCredential(env.GITHUB_TOKEN) }));
  if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN && env.CF_PAGES_SITES) {
    connectors.push(cloudflarePagesDeploy({ accountId: env.CF_ACCOUNT_ID, sites: JSON.parse(env.CF_PAGES_SITES), credential: cloudflareToken({ accountId: env.CF_ACCOUNT_ID, token: env.CF_API_TOKEN, permissions: ["Pages Write"] }) }));
  }
  if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN && env.CF_DNS_ZONES) {
    connectors.push(cloudflareDnsEdit({ zones: JSON.parse(env.CF_DNS_ZONES), credential: cloudflareToken({ accountId: env.CF_ACCOUNT_ID, token: env.CF_API_TOKEN, permissions: ["DNS Write"], resources: zoneScope }) }));
  }
  if (env.SLACK_BOT_TOKEN && env.SLACK_WORKSPACE) connectors.push(slackPost({ workspace: env.SLACK_WORKSPACE, credential: staticCredential(env.SLACK_BOT_TOKEN) }));

  const person = (userId: string): OkayedService => {
    let svc = people.get(userId);
    if (!svc) {
      const lifecycle = new InlineLifecycle(clock);
      const heuristic = new HeuristicDrafter();
      svc = new OkayedService({
        userId,
        store: new SqliteStore(db, userId),
        clock,
        signer: KeySigner.forUser(o.secret, userId),
        drafter: o.model ? new FallbackDrafter(new OpenAICompatibleDrafter(o.model), heuristic) : heuristic,
        lifecycle,
        random: cryptoRandom,
      });
      lifecycle.target = svc;
      people.set(userId, svc);
    }
    return svc;
  };

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/api" || url.pathname === "/api/") return Response.json({ name: "okayed", runtime: "node", tools: connectors.map((c) => c.id) });
    if (url.pathname === "/api/users" && req.method === "POST") {
      const me = issuers.length ? await personOf(req, issuers) : null;
      const id = me?.userId ?? cryptoRandom.hex(16);
      const token = await person(id).claim();
      return Response.json(token ? { userId: id, ownerToken: token, issuer: person(id).issuer } : { userId: id, access: true }, { status: token ? 201 : 200 });
    }
    const m = /^\/api\/u\/([0-9a-f]{32})(\/.*)$/.exec(url.pathname);
    if (!m) return Response.json({ error: "not found" }, { status: 404 });
    const svc = person(m[1]!);
    if (!(await svc.exists())) return Response.json({ error: "no such user" }, { status: 404 });
    return handleApi(svc, req, m[2]!, {
      connectors,
      relyingParty: (origin, r) => {
        const allowed = [new URL(r.url).origin, ...(o.origins ?? [])];
        if (typeof origin !== "string" || !allowed.includes(origin)) throw new OkayedError(400, `passkeys work from ${allowed.join(" or ")}`);
        return { origin, rpID: new URL(origin).hostname, rpName: "okayed" };
      },
      ...(issuers.length ? { isOwner: async (r: Request) => (await personOf(r, issuers))?.userId === m[1] } : {}),
    });
  };

  return createServer((req, res) => void serve(req, res, handle));
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS", "access-control-allow-headers": "authorization, content-type" };

/** Node's request and response, as the Fetch API's. */
async function serve(req: IncomingMessage, res: ServerResponse, handle: (r: Request) => Promise<Response>): Promise<void> {
  try {
    if (req.method === "OPTIONS") return void res.writeHead(204, CORS).end();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
    const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const out = await handle(new Request(url, { method: req.method ?? "GET", headers, ...(body ? { body } : {}) }));
    const outHeaders: Record<string, string> = { ...CORS };
    out.headers.forEach((v, k) => (outHeaders[k] = v));
    res.writeHead(out.status, outHeaders);
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json", ...CORS }).end(JSON.stringify({ error: (e as Error).message }));
  }
}
