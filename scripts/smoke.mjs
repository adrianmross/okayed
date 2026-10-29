// End-to-end check against a running Worker: node scripts/smoke.mjs [base-url]
// Creates a user and an agent, files a merge request, approves it in plain words, verifies the grant twice.
const BASE = process.argv[2] ?? "http://localhost:8787";
const SHA = "3f9a1c2e4b5d6f708192a3b4c5d6e7f801234567";
const PR = `github:adrianmross/okayed/pull/182@${SHA}`;

async function call(method, path, token, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await r.json();
  if (!r.ok && !path.endsWith("/verify")) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(json)}`);
  return json;
}

function check(cond, what) {
  console.log(`${cond ? "✓" : "✗"} ${what}`);
  if (!cond) process.exitCode = 1;
}

// The same checks run on any runtime; a few cover Cloudflare's own pieces and only run there.
const info = await (await fetch(`${BASE}/api`)).json();
const cloudflare = info.runtime !== "node";
console.log(`runtime: ${info.runtime ?? "cloudflare"}`);
const { userId, ownerToken } = await call("POST", "/api/users");
const u = `/api/u/${userId}`;
const { id: agent, token: agentToken } = await call("POST", `${u}/agents`, ownerToken, { name: "assistant" });
check(agent === "agent:assistant", `agent ${agent}`);

// Start from a policy that asks about everything, to walk the one-time flow; standing policies come after.
await call("PUT", `${u}/policy`, ownerToken, { rules: [] });
const req = await call("POST", `${u}/requests`, agentToken, { act: "github.pr.merge", res: [PR], why: "reviewed, CI green" });
check(req.status === "pending", `request ${req.request.id} is pending`);

const card = await call("POST", `${u}/chat`, ownerToken, { text: "I approve merging #182" });
check(card.kind === "grant", `card: ${card.sentence}`);
check(card.requestId === req.request.id, "card is bound to the pending request");

await call("POST", `${u}/cards/${card.id}/confirm`, ownerToken);
const st = await call("GET", `${u}/requests/${req.request.id}?wait=15`, agentToken);
check(st.status === "granted" && st.grant?.kind === 4841, `granted: kind ${st.grant?.kind}`);

const use = { event: st.grant, aud: agent, act: "github.pr.merge", res: PR, consume: true };
const first = await call("POST", `${u}/verify`, null, use);
check(first.ok === true && first.receipt?.kind === 4843, "first use accepted, receipt issued");
const second = await call("POST", `${u}/verify`, null, use);
check(second.ok === false && second.code === "used_up", `second use refused: ${second.reason}`);

const wider = await call("POST", `${u}/verify`, null, { ...use, res: PR.replace("182", "183"), consume: false });
check(wider.ok === false && wider.code === "wrong_resource", "a different PR is refused");

const policy = await call("POST", `${u}/chat`, ownerToken, { text: "auto-approve read-only GitHub for 1 hour; ask me before anything that spends money" });
check(policy.kind === "policy", `policy card: ${policy.sentence}`);
await call("POST", `${u}/cards/${policy.id}/confirm`, ownerToken);
const read = await call("POST", `${u}/requests`, agentToken, { act: "github.read", res: ["github:adrianmross/okayed"] });
const readSt = await call("GET", `${u}/requests/${read.request.id}?wait=15`, agentToken);
check(readSt.status === "granted", "read-only request auto-approved by policy");

// A standing policy: assistant may merge in okayed once without asking; the next one asks and says why.
await call("PUT", `${u}/policy`, ownerToken, { rules: [{ id: "merge-okayed", effect: "allow", act: "github.pr.merge", res: "github:adrianmross/okayed/**", agent: "agent:assistant", budget: { uses: 1 } }] });
const pr = (n) => `github:adrianmross/okayed/pull/${n}@${SHA}`;
const s1 = await call("POST", `${u}/requests`, agentToken, { act: "github.pr.merge", res: [pr(200)] });
const g1 = await call("GET", `${u}/requests/${s1.request.id}?wait=15`, agentToken);
check(g1.status === "granted" && JSON.parse(g1.grant.content).assurance.policy?.[0] === "merge-okayed", "a standing policy auto-approves a merge and is named on the grant");
const s2 = await call("POST", `${u}/requests`, agentToken, { act: "github.pr.merge", res: [pr(201)] });
check(s2.status === "pending", "once its budget is spent, the next merge asks");
await call("POST", `${u}/rules/merge-okayed/topup`, ownerToken);
const s3 = await call("POST", `${u}/requests`, agentToken, { act: "github.pr.merge", res: [pr(202)] });
const g3 = await call("GET", `${u}/requests/${s3.request.id}?wait=15`, agentToken);
check(g3.status === "granted", "after a top-up it goes ahead again");

// A shared budget spans policies: a merges-only pool of zero stops even this policy until topped up.
await call("PUT", `${u}/budgets`, ownerToken, { budgets: [{ id: "merges", scope: { act: "github.pr.merge" }, uses: 0 }] });
const s4 = await call("POST", `${u}/requests`, agentToken, { act: "github.pr.merge", res: [pr(203)] });
check(s4.status === "pending", "a spent shared budget asks, across policies");
await call("PUT", `${u}/budgets`, ownerToken, { budgets: [] });

// An approver app on another device: pair its key, read the inbox with a signed request, answer with a signed event.
const { publicKeyOf, signEvent } = await import("../packages/grant/src/index.ts");
const { answerTemplate } = await import("../packages/core/src/approvers.ts");
const phone = crypto.getRandomValues(new Uint8Array(32));
await call("POST", `${u}/approvers`, ownerToken, { pubkey: publicKeyOf(phone), name: "Phone" });
const s5 = await call("POST", `${u}/requests`, agentToken, { act: "site.deploy", res: ["site:openmeadow.org/production"], why: "launch" });
const inboxUrl = `${BASE}${u}/approvers/inbox`;
const nip98 = signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [["u", inboxUrl], ["method", "GET"]], content: "" }, phone);
const inbox = await (await fetch(inboxUrl, { headers: { authorization: `Nostr ${btoa(JSON.stringify(nip98))}` } })).json();
const pushed = inbox.find((x) => x.card === s5.cardId);
check(!!pushed, "a waiting request reaches the paired approver app's inbox");
await call("POST", `${u}/approvals`, null, { event: signEvent(answerTemplate({ v: 0, binding: pushed.binding, verdict: "allow" }, Math.floor(Date.now() / 1000)), phone) });
const g5 = await call("GET", `${u}/requests/${s5.request.id}?wait=10`, agentToken);
check(g5.status === "granted" && JSON.parse(g5.grant.content).assurance.method === "approver", "the app's signed answer issues the grant, with its proof");

// Any service's actions, from a capability pack: an agent asks to post to Slack; the person okays it in words.
const packs = (await call("GET", `${u}/state`, ownerToken)).packs ?? [];
if (packs.some((p) => p.id === "slack")) {
  const post = await call("POST", `${u}/requests`, agentToken, { act: "slack.message.post", res: ["slack:acme/releases"], why: "release notes" });
  const okay = await call("POST", `${u}/chat`, ownerToken, { text: "yes, post it" });
  check(okay.kind === "grant" && okay.draft.res[0] === "slack:acme/releases", `a custom action binds like a built-in one: ${okay.sentence}`);
  await call("POST", `${u}/cards/${okay.id}/confirm`, ownerToken);
  const posted = await call("GET", `${u}/requests/${post.request.id}?wait=10`, agentToken);
  check(posted.status === "granted" && JSON.parse(posted.grant.content).act === "slack.message.post", "and is granted, signed, for that channel only");
}

// Requests in other vocabularies: an agent may ask in OAuth's rich authorization request terms (RFC 9396).
const rich = await call("POST", `${u}/requests`, agentToken, { why: "notes", authorization_details: [{ type: "okayed", actions: ["github.read"], identifier: "github:adrianmross/okayed" }] });
check(rich.request.act === "github.read" && rich.request.res[0] === "github:adrianmross/okayed", "a request in authorization_details (RFC 9396) reads as okayed's own");

// An organization's identity provider provisions its people over SCIM, where the deployment has a SCIM token.
const scimOn = (await fetch(`${BASE}/scim/v2/ServiceProviderConfig`)).status === 401;
const SCIM_TOKEN = process.env.SCIM_TOKEN ?? (/localhost|127\.0\.0\.1/.test(BASE) ? "local-scim-token" : "");
if (scimOn && SCIM_TOKEN) {
  const scim = async (method, path, body) => {
    const r = await fetch(`${BASE}/scim/v2${path}`, { method, headers: { authorization: `Bearer ${SCIM_TOKEN}`, "content-type": "application/scim+json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: r.status === 204 ? null : await r.json() };
  };
  const name = `smoke-${Date.now()}@acme.dev`;
  const made = await scim("POST", "/Users", { userName: name, externalId: name });
  const group = await scim("POST", "/Groups", { displayName: `Smoke ${Date.now()}`, members: [{ value: made.body.id }] });
  const found = await scim("GET", `/Users?filter=${encodeURIComponent(`userName eq "${name}"`)}`);
  check(made.status === 201 && found.body.totalResults === 1 && found.body.Resources[0].groups.length === 1, "SCIM: an identity provider provisions a person and a group, and finds them by filter");
  const off = await scim("PATCH", `/Users/${made.body.id}`, { Operations: [{ op: "Replace", path: "active", value: "False" }] });
  check(off.body.active === false, "SCIM: and deactivates them");
  check((await scim("DELETE", `/Users/${made.body.id}`)).status === 204 && (await scim("DELETE", `/Groups/${group.body.id}`)).status === 204, "SCIM: and removes them");
  check((await fetch(`${BASE}/scim/v2/Users`, { headers: { authorization: "Bearer wrong" } })).status === 401, "SCIM: a wrong token is refused");
}

if (cloudflare) {
// A paired app with a wake URL is nudged through Cloudflare Queues; the nudge carries nothing.
const { createServer } = await import("node:http");
const woken = [];
const hook = createServer((req, res) => (woken.push(req.url), res.end("ok"))).listen(0);
const wakeUrl = `http://127.0.0.1:${hook.address().port}/wake`;
const tablet = crypto.getRandomValues(new Uint8Array(32));
await call("POST", `${u}/approvers`, ownerToken, { pubkey: publicKeyOf(tablet), name: "Tablet", wake: wakeUrl });
await call("POST", `${u}/requests`, agentToken, { act: "site.deploy", res: ["site:openmeadow.org/production"], why: "again" });
for (let i = 0; i < 40 && !woken.length; i++) await new Promise((r) => setTimeout(r, 500));
check(woken.length > 0, "the queue wakes the paired app with an empty nudge");
hook.close();

// Every signed event is archived to R2 shortly after it happens.
let archived = { events: [] };
for (let i = 0; i < 30 && !archived.events.some((e) => e.kind === 4841); i++) {
  await new Promise((r) => setTimeout(r, 1000));
  archived = await call("GET", `${u}/archive`, ownerToken);
}
check(archived.events.some((e) => e.kind === 4841) && archived.events.some((e) => e.kind === 4840), `signed events land in the R2 archive (${archived.events.length})`);

// The live-state socket must give nothing to a caller without the owner token.
async function socketTypes(token) {
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/agents/okayed-agent/${userId}${token ? `?token=${token}` : ""}`);
  const types = [];
  ws.onmessage = (e) => types.push(JSON.parse(String(e.data)).type);
  ws.onerror = () => {};
  await new Promise((r) => setTimeout(r, 1500));
  ws.close();
  return types;
}
check(!(await socketTypes(null)).includes("cf_agent_state"), "no state over the socket without a token");
check(!(await socketTypes("own_wrong")).includes("cf_agent_state"), "no state over the socket with a wrong token");
check((await socketTypes(ownerToken)).includes("cf_agent_state"), "the owner's socket gets live state");
}

const state = await call("GET", `${u}/state`, ownerToken);
check(state.audit.length > 0, `audit has ${state.audit.length} entries`);
console.log(`\nuser ${userId}\nowner token ${ownerToken}`);
