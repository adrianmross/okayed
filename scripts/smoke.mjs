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

const { userId, ownerToken } = await call("POST", "/api/users");
const u = `/api/u/${userId}`;
const { id: agent, token: agentToken } = await call("POST", `${u}/agents`, ownerToken, { name: "assistant" });
check(agent === "agent:assistant", `agent ${agent}`);

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

const state = await call("GET", `${u}/state`, ownerToken);
check(state.audit.length > 0, `audit has ${state.audit.length} entries`);
console.log(`\nuser ${userId}\nowner token ${ownerToken}`);
