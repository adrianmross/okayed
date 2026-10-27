// okayed as a remote MCP server, end to end: node scripts/mcp-remote.mjs [base-url]
// Registers an OAuth client, consents as the person (the same calls the Connect screen makes), trades the code for a
// token, then uses okayed's tools over MCP. Needs the Worker running (wrangler dev --env local).
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const BASE = process.argv[2] ?? "http://localhost:8787";
const sdk = createRequire(new URL("../apps/mcp/package.json", import.meta.url));
const { Client } = await import(sdk.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StreamableHTTPClientTransport } = await import(sdk.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"));

let failed = false;
const check = (cond, what) => {
  console.log(`${cond ? "✓" : "✗"} ${what}`);
  if (!cond) failed = true;
};
const b64url = (b) => Buffer.from(b).toString("base64url");

// The person has an okayed.
const { userId, ownerToken } = await (await fetch(`${BASE}/api/users`, { method: "POST" })).json();

// 1. A client registers itself (dynamic client registration), as Claude or Cursor would.
const REDIRECT = "http://127.0.0.1:9/callback";
const reg = await (await fetch(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Smoke MCP", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) })).json();
check(!!reg.client_id, "an MCP client registers itself");

// 2. It sends the person to /authorize, which binds the consent to their browser and opens the Connect screen.
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s1", scope: "okayed" });
const auth = await fetch(`${BASE}/authorize?${q}`, { redirect: "manual" });
const to = new URL(auth.headers.get("location") ?? "", BASE);
const cookie = auth.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const consent = new URLSearchParams(to.hash.replace(/^#connect\??/, ""));
check(auth.status === 302 && to.hash.startsWith("#connect") && consent.get("client") === "Smoke MCP", "/authorize sends the person to the Connect screen, naming the client");

// A different browser (no consent cookie) can't approve it, even as the owner.
const stolen = await fetch(`${BASE}/authorize/approve`, { method: "POST", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" }, body: JSON.stringify({ h: consent.get("h"), user: userId }) });
check(!stolen.ok, "the consent only works in the browser it was started in");

// 3. The person allows it on the Connect screen.
const approve = await fetch(`${BASE}/authorize/approve`, { method: "POST", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json", cookie }, body: JSON.stringify({ h: consent.get("h"), user: userId }) });
const approved = await approve.json();
const back = new URL(approved.redirectTo ?? "http://x/");
check(approve.ok && back.searchParams.get("state") === "s1" && !!back.searchParams.get("code"), "allowing it sends the client back with a code");

// 4. The client trades the code for a token.
const tok = await (await fetch(`${BASE}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code"), redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier }) })).json();
check(!!tok.access_token, "the code becomes an access token");

// 5. MCP with the token: okayed's tools, acting as the new agent.
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } }));
const tools = (await client.listTools()).tools.map((t) => t.name);
check(tools.includes("okayed_request") && tools.includes("okayed_actions"), `the MCP server lists okayed's tools (${tools.join(", ")})`);
const read = await client.callTool({ name: "okayed_request", arguments: { action: "github.read", resources: ["github:adrianmross/okayed"], why: "smoke test", wait_seconds: 5 } });
check(/^Granted by standing policy/.test(read.content[0].text), "a read the person's rules allow is granted over MCP");
const spend = await client.callTool({ name: "okayed_request", arguments: { action: "spend.money", resources: ["money:card-1/USD/5"], why: "smoke test", wait_seconds: 0 } });
check(/^Waiting for the person/.test(spend.content[0].text), "spending asks the person instead");
await client.close();

// The client is one of the person's agents now.
const state = await (await fetch(`${BASE}/api/u/${userId}/state`, { headers: { authorization: `Bearer ${ownerToken}` } })).json();
check(state.agents.some((a) => a.id === approved.agent), `the client shows up as agent ${approved.agent}`);
const unauth = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check(unauth.status === 401, "/mcp refuses a request without a token");

process.exit(failed ? 1 : 0);
