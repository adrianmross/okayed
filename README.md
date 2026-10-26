# okayed

**Scoped-authority approvals for AI agents.** People tell their agents things like *"I approve merging #182"* or
*"go ahead and deploy the website"*. Nothing can verify a sentence like that. okayed turns it into the **narrowest
exact, signed, expiring grant** it can mean, shows that grant to the person to confirm, and lets any tool verify the
grant before it acts.

> "I approve merging #182" → **Lets assistant merge PR #182 in adrianmross/okayed at 3f9a1c2, once, within the next 15
> minutes.** It does not cover any other PR, a newer commit, a second use, or any other agent.

- **Web demo:** _deployed link goes here_ · **Playground:** _deployed link goes here_
- Runs on Cloudflare: Workers AI (Llama 3.3), Agents SDK (a Durable Object per user, `AIChatAgent` for the chat),
  Workflows, and Pages. The core is provider-agnostic, and the components install into any shadcn app.
- MIT licensed. The prompts behind this AI-assisted build are in [`PROMPTS.md`](PROMPTS.md).

## The demo

Chat with an assistant that can merge pull requests, deploy sites, comment and buy things. Its tools are simulated:
nothing real happens. Every tool call still goes through okayed, and the permissions it signs are real.

- If your rules allow the call, it goes ahead with a one-time permission, and a receipt appears in the chat.
- If they ask you, an approval card appears under the tool call: the plain sentence, the exact scope, the risk, and
  what was left out of the draft. **Allow once** signs a WebAuthn assertion (Face ID, Touch ID) over that exact
  request, and the assertion travels with the permission. **Always allow…** opens the narrowest rule that covers
  requests like this one, and allows this one with the same Face ID.
- If a rule blocks it, the assistant is refused and says so.

Each conversation has three views: **Chat**, **Receipts** and **Transcript** (every tool input and output, okayed
request and grant, as data). **Rules** is a library you build like Siri Shortcuts. **Activity** has what's waiting,
the permissions agents hold right now (take any of them back), and a history of signed receipts.

| The assistant asks; you allow it with Face ID | Then it carries on, with receipts |
|---|---|
| ![An approval card under the assistant's deploy tool call](docs/img/demo-approval.png) | ![Receipts for a merge your rules allowed and a deploy you allowed with Face ID](docs/img/demo-chat.png) |

| “Always allow…” opens the narrowest rule | Your rules, on a phone |
|---|---|
| ![The rule editor, prefilled from a production deploy request](docs/img/demo-always-allow.png) | ![Rule tiles on a phone](docs/img/demo-rules-mobile.png) |

**Words.** The app speaks in everyday words. The API, the grant format and the docs keep the IAM ones:

| In the app | In the API and docs |
|---|---|
| a **request** ("Assistant wants to…") | request (kind 4840) |
| **Allow** · **Ask me** · **Block** | `allow` · `ask` · `deny` |
| a **rule** | a rule in your layer of the policy |
| a **permission** | a grant (kind 4841) |
| a **receipt** | a use receipt (kind 4843) |
| a **limit**, in uses or points | a budget (`budget`, `budgets`) |
| **Take back** · **Stop everything** | revoke (4842) · emergency stop (4844) |

## Why

Agents act under borrowed authority. Today that authority is a long-lived token plus a sentence in a chat log. The
agent decides what the sentence meant, and the tool trusts the agent. okayed makes the authority explicit and
answers three questions in miniature:

1. **Who is the agent acting for?** The grant is issued by the person's key (`iss`) to one agent (`aud`).
2. **What can it touch?** One action on exact targets: repo + PR + commit SHA, or site + environment. No wildcards.
3. **How do you take it back?** Every grant expires on its own. You can revoke any grant at any time, and an
   emergency stop revokes them all.

## How it works

```mermaid
sequenceDiagram
    autonumber
    participant A as Agent
    participant W as okayed Worker
    participant DO as OkayedAgent<br/>(Durable Object per user)
    participant WF as GrantLifecycle<br/>(Workflow)
    participant LLM as Llama 3.3<br/>(Workers AI)
    participant P as Person (Pages UI)
    participant T as Tool (GitHub merge)

    A->>W: POST /requests {act, res, why}
    W->>DO: submitRequest
    DO->>DO: engine: bind + narrow + decide (pure)
    DO->>WF: start flow (propose → await confirm)
    DO-->>P: card over WebSocket: sentence, allows / does not, risk
    P->>W: "I approve merging #182"
    W->>DO: chat
    DO->>LLM: draft a grant (JSON)
    LLM-->>DO: proposal (untrusted)
    DO->>DO: engine cuts it to what was said, shows what it cut
    P->>W: Confirm
    DO->>WF: event: decision=confirm
    WF->>DO: issue → signed kind 4841, NIP-40 expiration
    A->>W: GET /requests/:id → grant event
    A->>T: merge #182 with the grant
    T->>DO: verify + consume (atomic, so once means once)
    T->>T: swap in the real token, merge at the pinned SHA
    WF->>DO: at exp: expire (or end early on revoke)
```

**The model drafts; a deterministic engine decides.** Llama 3.3 does two things: it turns plain language into a
*proposed* grant or policy, and it explains requests in plain words. Allow and deny, narrowing, risk, lifetimes and
use counts all come from pure, tested TypeScript in [`packages/engine`](packages/engine). The engine treats the
model's output as hostile input. A prompt injection can at most make the model propose something the engine then
cuts, and the cut is shown on the card ("asked for X, granted Y, refused Z because …").

### Design rules, and where each one lives

| Rule | Where |
|---|---|
| Least privilege by construction: exact targets, shortest reasonable lifetime, fewest uses | `engine/src/narrow.ts`, `engine/src/catalog.ts` |
| Never broader than what the person said. Every pinned value comes from their words or the one request they point at | `engine/src/anchors.ts`, `narrowGrant` |
| Ambiguity is a question ("Which site?", "Which environment?", "Which commit?") | `bind` / `bindFromWords` in `narrow.ts` |
| Standing policies for repeat actions, bounded by horizon, count, risk budget and conditions; each use is still its own exact grant | `engine/src/policy.ts`, `core/src/service.ts` |
| Layered policy: each layer can only narrow the one above; the reason names the first layer that refuses | `engine/src/policy.ts` |
| "Once" means exactly one use: the Durable Object decrements inside a storage transaction | `OkayedService.verify` |
| Revocable at any time; expiry enforced by the Workflow and by verifiers | `core/src/flow.ts`, `engine/src/use.ts` |
| The agent never sees the GitHub token: the Worker swaps it in only under a live grant | `core/src/github.ts` |

The grant format (JSON, JCS-hashed id, signed as a Nostr event, kinds 4840–4844 and 34840) is specified in
[`docs/grant-format.md`](docs/grant-format.md). The design notes are in [`docs/design.md`](docs/design.md).

## Standing rules

A one-time okay is the narrow case. Most of the time you want an agent to get on with things:

> “always allow merges in okayed when checks pass for 2 weeks, up to 30 merges”

That becomes a rule: repo `adrianmross/okayed`, condition `checks.pass`, a 14-day horizon and a limit of 30. Each
merge under it is allowed as its own one-time permission, pinned to the PR's head commit, and the permission names
the rule that allowed it. **Always allow…** on an approval card builds the same kind of rule from a real request.

**Limits are optional.** Put one on a single rule ("up to 30 merges"), or add a limit shared across rules: global
("everything, 100 points this week"), for one action ("merges, 10 a day") or for one agent ("the assistant, 50 points
this week, counting what I allow too"). Points weigh actions by risk. When a limit runs out, the next request asks
you, the card says what used it up, and one tap resets it.

New users start from the **Balanced** preset and no limits: reads, comments, merges with passing checks, and staging
deploys are allowed; production deploys and spending ask. These are ordinary rules you can change in Rules, by
tapping a word, or in words. The model's draft of a rule can't widen what you said.

## Approvers

Every approval signs the same thing: the card, a hash of its exact draft, and a nonce. Today the approver is local, a
passkey in the browser. The approver is a port, so an approval can also go to an app on another device, such as a
phone: pair the app's public key (`POST /approvers`), and okayed keeps what's waiting in an inbox the app reads with
a signed request (NIP-98). The app answers with a signed approval event (kind 4845), which becomes the grant's proof
(`assurance.method: "approver"`). A `Notifier` port can wake the app; the wake carries nothing. okayed's side is
built and tested end to end. No app ships with it yet.

## Interpreting people

The model only drafts, so it never decides, but a better reader asks fewer needless questions. `packages/core`
drafts with Workers AI (Llama 3.3 by default), or any OpenAI-compatible endpoint (`DRAFTER=openai-compatible`), and
falls back to the model-free heuristic. Twenty eval cases, from plain okays to prompt injections, are scored by what
the engine ends up doing with each draft:

```bash
pnpm --filter @okayed/core test interpret                     # the heuristic: 18/20 intent, 17/20 outcome
EVAL_MODELS="cf:@cf/meta/llama-3.3-70b-instruct-fp8-fast,cf:@cf/openai/gpt-oss-120b" \
  CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… pnpm --filter @okayed/core test interpret
EVAL_MODELS="openai:gpt-5-mini" OPENAI_API_KEY=… pnpm --filter @okayed/core test interpret
```

Part of the work is a bounded choice (is this an okay, a rule or a question; which pending request; which site), and
the intent column scores it on its own. Fast decision models, such as OpenAI's Decisions API, fit that part. See
[`docs/design.md`](docs/design.md#interpreting-people).

## Repository layout

```
packages/engine      pure decision engine: anchors, binding, narrowing, standing policies, budgets, use checks
packages/grant       grant format v0: JCS, ids, Nostr events, BIP-340 signatures, per-user issuer keys
packages/core        provider-neutral service behind ports (Store, Signer, Drafter, Lifecycle, Vault, Clock,
                     Notifier), the lifecycle flow, prompts, drafters (OpenAI-compatible, model-free), approvers
                     (passkeys, paired apps), in-memory adapters, the GitHub tool, the demo's tools, and evals
packages/design      okayed's design system: tokens, the latest shadcn components, AI Elements for chat, and
                     okayed's approval card, receipts, rule tiles and Shortcuts-style editor, also served as a
                     shadcn registry (docs/design-system.md)
packages/client      a dependency-free client for agents: ask, wait, merge
apps/worker          Cloudflare: OkayedAgent (Durable Object per user), OkayedChat (AIChatAgent), the Workflow,
                     Workers AI, the HTTP API
apps/web             Pages: the demo (Chat, Rules, Activity, Settings), React on @okayed/design, and /r/ (the registry)
apps/playground      Pages: ask your rules, build one, and watch words narrow into a grant; the engine in the browser
apps/mcp             MCP server so any MCP agent asks okayed before acting
docs/                design notes, grant format, design system
scripts/             smoke.mjs (API, end to end) and e2e-web.mjs (the demo in a browser, Face ID included)
```

## Run it locally

Requires Node 22 and pnpm 10.

```bash
pnpm install
pnpm test                      # engine, grant, core and worker tests
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
# put 64 hex chars in ISSUER_SECRET:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
pnpm dev:local                 # the Worker on :8787, Durable Objects + Workflows, no Cloudflare login
pnpm dev:web                   # the demo on :5173
pnpm dev:playground            # the playground on :5174
pnpm e2e                       # the API end to end, then the demo in a browser with a virtual Face ID
```

`dev:local` runs every part except Workers AI. The assistant is then played by a scripted model that reads intent with
okayed's own anchors, and policy drafting uses the model-free `HeuristicDrafter`, so the whole demo works offline.
To use Llama 3.3, run `wrangler login` and then `pnpm dev:worker`. The model only drafts; okayed still decides.

Face ID works on `localhost`: browsers treat it as a secure context, and the Worker accepts passkeys from the
origins in `WEB_ORIGINS`.

### Talk to it like an agent

```bash
API=http://localhost:8787
# In the web app: Settings → Add agent → copy the token. Or:
read U OWNER < <(curl -s -X POST $API/api/users | node -pe 'const j=JSON.parse(require("fs").readFileSync(0));j.userId+" "+j.ownerToken')
AGENT=$(curl -s -X POST $API/api/u/$U/agents -H "authorization: Bearer $OWNER" -d '{"name":"assistant"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

# 1. The agent asks.
curl -s -X POST $API/api/u/$U/requests -H "authorization: Bearer $AGENT" \
  -d '{"act":"github.pr.merge","res":["github:adrianmross/okayed/pull/182@3f9a1c2e4b5d6f708192a3b4c5d6e7f801234567"],"why":"reviewed, CI green"}'

# 2. The person says yes in the web app ("I approve merging #182"), or:
curl -s -X POST $API/api/u/$U/chat -H "authorization: Bearer $OWNER" -d '{"text":"I approve merging #182"}'
curl -s -X POST $API/api/u/$U/cards/<card id>/confirm -H "authorization: Bearer $OWNER"

# 3. The agent collects the signed grant (long-polls up to 20 s).
curl -s "$API/api/u/$U/requests/<request id>?wait=10" -H "authorization: Bearer $AGENT"

# 4. A tool verifies before acting. "consume": true spends a use atomically.
curl -s -X POST $API/api/u/$U/verify -d '{"event":<grant event>,"aud":"agent:assistant","act":"github.pr.merge","res":"github:…","consume":true}'
```

Or let okayed perform the action: `POST /api/u/:user/tools/github/merge {grant, owner, repo, number, sha}`. The
Worker verifies and consumes the grant, checks `checks.pass` when the grant requires it (without spending the use if
the checks fail), then merges with its own `GITHUB_TOKEN`, passing GitHub's `sha` guard so a moved head is refused.
The agent never holds the token.

### Use it from any MCP agent

`apps/mcp` is an MCP server with four tools:

- `okayed_actions` lists the actions and how to name exact targets.
- `okayed_request` asks before acting. It returns at once if one of your rules allows the action; otherwise it waits for you.
- `okayed_status` keeps waiting on a request.
- `okayed_merge_pr` merges through okayed's tool.

Grants stay inside the MCP process, so the agent sees what it may do but never holds a credential.

```json
{
  "mcpServers": {
    "okayed": {
      "command": "node",
      "args": ["/path/to/okayed/apps/mcp/src/main.ts"],
      "env": { "OKAYED_API": "https://okayed.<you>.workers.dev", "OKAYED_USER": "<user id>", "OKAYED_TOKEN": "agt_…" }
    }
  }
}
```

For code that isn't an MCP agent, `packages/client` does the same in a few lines:

```ts
const okayed = new OkayedClient({ api, user, token });
const a = await okayed.ask("github.pr.merge", [prResource("adrianmross", "okayed", 182, sha)], "CI is green");
if (a.status === "granted") await okayed.merge(a.event!, { owner: "adrianmross", repo: "okayed", number: 182, sha });
```

## Deploy (Cloudflare)

Everything here runs on the free plan: Workers, Durable Objects (SQLite), Workflows, the Workers AI free
allocation, and Pages.

```bash
cd apps/worker
npx wrangler login
npx wrangler deploy
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put ISSUER_SECRET
npx wrangler secret put GITHUB_TOKEN        # optional: fine-grained, PR write on the demo repo only

cd ../..
VITE_API_BASE=https://okayed.<you>.workers.dev VITE_PLAYGROUND_URL=https://okayed-playground.pages.dev pnpm --filter @okayed/web build
VITE_WEB_URL=https://okayed.pages.dev pnpm --filter @okayed/playground build
npx wrangler pages deploy apps/web/dist --project-name okayed
npx wrangler pages deploy apps/playground/dist --project-name okayed-playground
```

Or add the `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `ISSUER_SECRET` repository secrets and run the
**deploy** workflow.

### Use the components in your own app

The web build also publishes okayed's design system as a [shadcn registry](https://ui.shadcn.com/docs/registry) at
`/r/`: the theme, the engine and each component.

```bash
npx shadcn add https://okayed.pages.dev/r/approval-card.json
# or add "@okayed": "https://okayed.pages.dev/r/{name}.json" to "registries" in components.json, then:
npx shadcn add @okayed/okayed
```

## Cloudflare assignment checklist

| Requirement | Here |
|---|---|
| LLM | Llama 3.3 70B on Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`): the demo assistant's tool calling (`apps/worker/src/chat.ts`), plus drafting and explaining approvals and policies (`adapters.ts`) |
| Workflow / coordination | Agents SDK: `OkayedAgent` (a Durable Object per user) and `OkayedChat` (`AIChatAgent`, per user); `AgentWorkflow` for request → propose → await confirm → issue → expire/revoke |
| User input | Chat on Pages (`apps/web`), with AI SDK tool approval wired to okayed and live state over the Agents SDK WebSocket. Voice via Realtime is a stretch goal and not built. |
| Memory / state | Chat history in `OkayedChat`'s SQLite; rules, limits, requests, grants with use counters, passkeys, paired approvers and the audit log in `OkayedAgent` |

## Not tied to Cloudflare

Only `apps/worker` imports Cloudflare APIs. The service in `packages/core` depends on six small ports, plus an
optional `Notifier` for approver apps. The flow
(`runGrantFlow`) is written once, and both Workflows and the in-memory runtime run it. Moving to another provider
means implementing `Store` (needs a serializable transaction, e.g. a Postgres row lock), `Lifecycle` (Temporal, or a
queue plus timers), `Drafter` (`OpenAICompatibleDrafter` already speaks to any OpenAI-compatible endpoint), `Signer` (KMS or HSM) and `Vault`. The core
test suite already runs the whole flow (request, confirm, issue, once-only use, revoke, expiry, emergency stop) on
the in-memory adapters in Node.

## Where it fits

- **OpenMeadow's thesis in miniature:** who the agent acts for (`iss` → `aud`), what it can touch (`act` + exact
  `res`), and how you take it back (`exp`, revoke, emergency stop).
- **Nostr:** requests, grants, revokes, receipts and approvals are ordinary signed Nostr events with NIP-40
  expiration, so any relay can carry them as they are.

## Limitations (v0)

- Identity is a bearer owner token per user and minted agent tokens. Passkeys sign approvals, but don't yet sign
  you in.
- The demo's tools are simulated. The GitHub merge tool in `core/src/github.ts` is real and takes the same grants.
- One action per grant. There are no delegation chains, and events are not yet published to relays.
- `POST /verify` with `consume: true` requires the grant event, not just its id. Anyone holding the event can spend
  its use, which is safe for the intended flow (agent → tool) but is not proof of who the caller is.
- Learned PR heads come from agent requests unless `GITHUB_TOKEN` is set. With the token, the Worker checks the head
  against GitHub and refuses a mismatch.
- Paired approver apps work end to end on okayed's side, but no app ships with okayed yet, and no `Notifier` adapter
  is wired up on Cloudflare: an app polls its inbox.
- The interpretation evals compare models only with your API credentials. The numbers here are the heuristic's.
- Event kinds 4840–4845 and 34840 are placeholders, not registered NIPs.

## License

[MIT](LICENSE) © 2026 Adrian Ross
