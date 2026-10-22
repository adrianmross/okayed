# Prompt history

okayed was built with AI-assisted coding, which the Cloudflare assignment encourages. It asks for the prompts to be
included, so this file has every prompt given to the coding assistant (Claude Code, running in a cloud session),
verbatim and in order, minus personal notes; names of unreleased projects are [redacted]. Follow-up prompts are appended as they happen.

How the assistant was used: it wrote the design doc and grant format first, then the engine and its tests, then
the Worker, then the two UIs. I reviewed the work at each stage. Commits follow Conventional Commits under my name.
The model-facing prompts that okayed itself sends to Llama 3.3 are in
[`packages/core/src/prompts.ts`](packages/core/src/prompts.ts).

---

## 1 — Initial brief

```text
Build a small open-source project called okayed: a scoped-authority approval service for AI
agents, on Cloudflare. MIT license. Conventional Commits, author Adrian Ross <72167238+adrianmross@users.noreply.github.com>,
no AI attribution in commits. Keep the full prompt history in PROMPTS.md.

The problem. People tell their agents things like "I approve merging #182" or "go ahead and deploy the website".
That sentence is not an authorization anything can verify. okayed turns it into the narrowest exact, signed,
expiring grant, shows it to the person for confirmation, and lets any tool verify the grant before acting.

Requirements (all must be present):

	1.	LLM: Llama 3.3 on Workers AI.
	2.	Coordination: Agents SDK; a Durable Object per user; a Workflow for the grant lifecycle.
	3.	User input: chat UI on Pages (voice via Realtime is a stretch goal).
	4.	Memory/state: per-user policy, pending requests, active grants, audit log in the Durable Object.

Design rules:

	•	The model drafts; a deterministic engine decides. The LLM only (a) turns plain language into a proposed grant and
(b) explains requests and decisions in plain words. Allow/deny and narrowing are pure, tested TypeScript.
	•	Least privilege by construction: grants pin exact targets (e.g. repo + PR + commit SHA; site + environment),
shortest reasonable lifetime, fewest uses. The engine refuses anything broader than what the person said, and shows
what it cut ("asked for X, granted Y, refused Z because ...").
	•	Ambiguity is a question, not a guess ("which site?", "which environment?").
	•	"Once" means exactly one use: the Durable Object decrements atomically; a second use is refused.
	•	Every grant is revocable at any time; expiry is enforced by the Workflow and by verifiers.

Grant format (v0, JSON, signed as a Nostr event; kinds are placeholders, not registered):
{v, id (JCS hash), iss, aud, act, res[], when[], nbf, exp, uses, risk, assurance, from{utterance, request}, nonce}.
Kinds: 4840 request, 4841 grant, 4842 revoke, 4843 use receipt, 4844 emergency stop, 34840 policy. Use NIP-40
expiration tags. assurance records how the person confirmed (web click today; a hardware-key proof can plug in later).
Document the format in docs/grant-format.md.

Pieces:

	•	packages/engine: pure engine. Policy = layered rules (each layer can only narrow the one above); decision = allowed
only if every layer allows; the reason names the first layer that refuses; a "beyond" list shows what was asked but
not granted. Plenty of unit tests, including adversarial ones (prompt tries to widen scope).
	•	apps/worker: Agents SDK agent; Durable Object per user; Workflow: request -> propose -> await confirm -> issue ->
expire/revoke; HTTP API for agents to submit requests and for tools to verify grants (POST /verify).
	•	apps/web (Pages): chat to set policy in plain words ("auto-approve read-only GitHub for 1 hour; ask me before
anything that spends money"), see pending requests rendered as a clear card (plain sentence, what it allows, what it
does not, risk), confirm/deny/revoke, and an audit view.
	•	apps/playground (Pages): a policy playground. Write a policy, ask a question, see allow/deny with a one-sentence
reason and a per-layer breakdown; one-tap "what if" edits; headline demo: plain-language approval -> proposed grant ->
engine narrows it -> diff of what was cut.
	•	Demo tool: a GitHub action (e.g. merge a PR in a demo repo) where the agent never sees the token; the Worker swaps
in the real credential only under a live grant.

Deliverables: deployed links (web + playground), README (what it is, why, how to run locally and deploy,
architecture diagram), PROMPTS.md, docs/grant-format.md, tests passing in CI (GitHub-hosted runners are fine).

Start by writing a short design doc and the grant format, then the engine with tests, then the Worker, then the UIs.
Ask before adding any paid Cloudflare feature.

Even though this will support cloudflare first I’d appreicagd if you design for an agnostic provider in the future
```

### What came out of it

| Order | Commit | What |
|---|---|---|
| 1 | `docs: add design doc and v0 grant format` | `docs/design.md`, `docs/grant-format.md` |
| 2 | `feat(engine): …` | Pure engine and 79 tests, including prompt-injection and hostile-draft cases |
| 3 | `feat(grant): …` | JCS ids, Nostr events, BIP-340 signatures, per-user HKDF issuer keys |
| 4 | `feat(core): …` | Provider-neutral service, ports, the lifecycle flow written once, in-memory adapters, end-to-end tests |
| 5 | `feat(worker): …` | Agents SDK agent per user, `AgentWorkflow`, Workers AI drafter, HTTP API, a local env with no login |
| 6 | `feat(web): …` | Chat UI with live state over the Agents SDK WebSocket |
| 7 | `feat(playground): …` | The engine in the browser: policy what-ifs and the narrowing demo |
| 8 | `ci: …`, `docs: …` | CI with unit tests and an end-to-end run against `wrangler dev`; README; this file |

No paid Cloudflare features were added. Workers, Durable Objects (SQLite), Workflows, the Workers AI free allocation
and Pages are all available on the free plan.
