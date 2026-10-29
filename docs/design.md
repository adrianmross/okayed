# okayed — design

## The problem

People tell their agents things like "I approve merging #182" or "go ahead and deploy the website". Nothing can
verify that sentence. It doesn't say which repository or which commit is meant, how long the approval lasts, or
whether it covers one merge or every merge from now on. The agent ends up deciding what the person meant, and the
tool trusts the agent's account.

okayed sits between the sentence and the tool:

1. **Draft.** A language model reads the sentence and *proposes* a grant: action, exact targets, lifetime, uses.
2. **Decide.** A deterministic engine treats the proposal as untrusted input. It cuts it down to what the person's
   words and the agent's pending request both support, then checks the result against the person's layered policy.
   Anything it cut is listed with a reason.
3. **Confirm.** The person sees a card: one plain sentence, what it allows, what it does not, the risk, and what was
   cut. They confirm or deny. Policy can auto-approve low-risk things without a card.
4. **Issue.** The grant is signed as a Nostr event (kind 4841), with an `expiration` tag (NIP-40).
5. **Verify.** Before acting, the tool calls `POST /verify` (or checks the signature offline, then asks for the
   use). The service checks the signature, time window, revocation and exact match, and decrements `uses`
   atomically. A second use of a "once" grant is refused.
6. **Expire / revoke.** A Workflow expires the grant at `exp`. The person can revoke it at any time, and verifiers
   enforce `exp` on their own as well.

## Principles

- **The model drafts; the engine decides.** The LLM has two jobs: turn plain language into a proposal, and explain
  requests and decisions in plain words. Allow, deny and narrowing are pure TypeScript in `packages/engine`, with no
  I/O, no clock, and no randomness. A prompt injection can at most make the model propose something that the engine
  then cuts.
- **Least privilege by construction.** A grant names one action and exact targets, with no wildcards. A PR merge is
  pinned to repo, PR number and head commit; a deploy to site and environment. Each grant gets the shortest
  reasonable lifetime and the fewest uses.
- **Never broader than what was said.** Every identifying value in a grant (PR number, repo, site, environment) must
  come from the person's words or from the one pending request those words unambiguously point at. If the proposal
  goes beyond that, the engine refuses the excess and reports it: "asked for X, granted Y, refused Z because …".
- **Ambiguity is a question.** If two pending requests or two known sites fit the words, or no environment can be
  bound, the engine returns a question ("Which site: openmeadow.org or buzz.dev?") instead of a grant.
- **Once means once.** The use counter lives in the user's Durable Object, the single writer for that user, and is
  decremented within one storage transaction.
- **Everything can be taken back.** Grants are revocable at any time. An emergency stop (kind 4844) revokes every
  live grant and pauses auto-approval.

## Policy model

Policy is **standing authority**: what an agent may do again and again, within bounds the person picks. The engine
draws the same line for every kind of grant. A policy decides whether a use needs the person, and every use is
still issued as its own exact, once-only grant pinned to its target.

A policy is a stack of **layers**: optionally an organization's or community's ceiling, then the person's own layer.
Each layer holds rules:

```ts
{ id, effect: "allow" | "ask" | "deny",
  act: "github.pr.merge", res?: "github:adrianmross/okayed/**", agent?: "agent:assistant",
  from?: unix, until?: unix,               // the horizon
  budget?: { uses?: n, risk?: n },         // totals across every grant it auto-approves
  when?: [{ c: "checks.pass" }],           // conditions every grant under it must carry
  maxTtl?: seconds, maxUses?: n }          // caps on each grant
```

- Within a layer, the **most specific** matching rule wins (action, then resource, then agent). On a tie, the
  strictest one wins (deny > ask > allow). A layer with no matching rule falls back to its default; the person's
  layer asks.
- Across layers, the **strictest verdict wins**, so a layer can only narrow the one above it. The reason names the
  first layer that refused or asked. Per-grant caps are the minimum across layers.
- **Budgets are opt-in.** Every use is counted against the rule that allowed it, so each policy shows how often it
  has been used. A budget makes that count a limit. Budgets come in two kinds:
  - **On one policy** (`budget` on a rule): "this merge policy, 30 times".
  - **Shared** (`budgets` on the policy): a pool across every policy in its scope. With no scope it's global
    ("everything, 100 risk this week"); a scope narrows it to one action, one agent or a set of resources
    ("merges, 10 a day"). A pool counts auto-approvals, or with `counts: "all"` your own okays too.

  Each action has a risk cost (low 1, medium 3, high 8, critical 20; a production deploy counts as high). A use
  that a budget can't cover asks instead of auto-approving. The card says what spent the budget, and a top-up resets
  it in one decision. Counters live in the person's Durable Object and are charged in the same transaction that
  issues the grant.
- **Default posture ("balanced").** New users start with ordinary rules in their own layer, which they can edit or
  delete, and no budgets:
  - reads and comments go ahead
  - merges go ahead when checks pass
  - staging and preview deploys go ahead
  - production deploys and spending ask
- **From words.** "always allow merges in okayed when checks pass for 2 weeks, up to 30 merges" becomes a standing
  rule with a repo scope, a condition, a horizon and a count. The model's draft can't widen any of these. How
  open-ended a rule is stays the person's call.
- **From a request.** "Always allow…" on an approval card starts from `ruleFromRequest`: the narrowest rule that
  covers requests like this one (a PR becomes its repository; a deploy keeps its site and environment; a purchase
  keeps its amount; the agent and conditions carry over). The person widens it in the editor if they mean more.

## Words

The app speaks in everyday words and the API keeps the IAM ones, so people read the app easily and developers get
precise terms. Each pair names one thing:

| In the app | In the API, the format and these docs |
|---|---|
| request ("Assistant wants to…") | request (kind 4840) |
| Allow · Ask me · Block; Allowed · Asks you · Blocked | `allow` · `ask` · `deny` |
| rule | a rule in the person's policy layer |
| permission | grant (kind 4841) |
| receipt | use receipt (kind 4843) |
| limit (uses or points) | budget; risk cost |
| Take back · Stop everything | revoke (4842) · emergency stop (4844) |
| Presets | default posture |
| Allow once · Always allow… | confirm a card · `ruleFromRequest` |

## Components

```
                ┌──────────── one Worker (apps/worker) ────────────────────────────────┐
 person ──web──▶│ static assets: the demo, /playground, /r (shadcn registry)          │
   (Access, ───▶│ /api        owner API, agent API, POST /verify (anyone)            │
   Turnstile)   │ /agents/*   live state and the demo chat over WebSocket            │
 agent ──MCP───▶│ /mcp        remote MCP (OAuth: /authorize → Connect → /token)       │──▶ Workers AI
 tool ──verify─▶│                                                                      │    (Llama 3.3, Whisper,
                │  OkayedAgent  Durable Object per person: policy · requests · grants │     via AI Gateway)
                │               · use counters · audit · paired approvers             │
                │  OkayedChat   AIChatAgent per person (the demo assistant)           │──▶ Queues → approver apps
                │  OkayedMcp    McpAgent per MCP session                              │──▶ R2 (event archive)
                │  GrantLifecycle (Workflow): propose → await → issue → expire/revoke │──▶ Analytics Engine
                │  tools: connectors, each with a credential minted for the one call  │──▶ GitHub, Cloudflare API
                └──────────────┬───────────────────────────────────────────────────────┘
                               │ imports
          packages/core ── the service, its HTTP API, identity and connectors, behind ports (Store, Signer, Drafter,
                           Lifecycle, Clock, Notifier); @okayed/connectors for GitHub, Cloudflare, Slack
          packages/engine ─ pure: catalog, resources, anchors, policy, narrowing, use checks
          packages/grant ── format: JCS, ids, Nostr events, signatures
```

## Provider-agnostic by design

The core is platform-neutral in five ways:

- **Runtime.** `packages/core` holds the service and the whole per-person HTTP API (`handleApi`) on the Fetch API's
  `Request` and `Response`, with hooks for what a platform adds (identity, tools, limits, metrics, extras). It uses
  only erasable TypeScript, so Node, Deno and Bun run it without a build. The Worker's Durable Object serves it over
  RPC; `apps/node` serves it on SQLite.
- **Actions.** Capability packs (`packages/engine/src/capabilities.ts`) declare any service's actions and resource
  types as data. A deployment picks packs by name or brings its own; the snapshot carries them so the browser
  registers the same; the service learns the names of their targets from requests, so words bind to them.
- **Connectors and credentials.** `performWithGrant` is the one way anything acts under a grant: check without
  spending (with the facts conditions need), spend one use, act, release the credential. A `CredentialSource` is a
  stored secret or one minted per call, scoped to what the call touches and dead with the grant
  (`@okayed/connectors`: GitHub App tokens per repository, Cloudflare tokens per zone or for Pages).
- **Identity.** People prove themselves with an owner token, Cloudflare Access or any OIDC provider's ID token
  (`personOf`); agents with an agent token, OAuth (remote MCP) or a workload identity token from their platform that
  the person trusts (`trustWorkload`, `agentForWorkload`), so CI holds no secret.
- **Other permission systems.** Limits from outside the person (`setCeiling`) are layers above their rules that can
  only narrow them. `@okayed/interop` fills them from an organization's policy by group, with groups from SCIM, OIDC
  claims, Cloudflare Access or SAML, and from OAuth scopes. Removing someone from the directory stops their okayed.
  Agents can be in groups (`group:<name>` in rules), and requests and grants translate to and from RFC 9396
  `authorization_details` and UCAN delegations ([interop.md](interop.md)).

Cloudflare comes first, but only `apps/worker` imports Cloudflare APIs. Everything else goes through ports defined
in `packages/core`:

| Port | What it needs | Cloudflare adapter | Elsewhere |
|---|---|---|---|
| `Store` | per-user key/value with a serializable `transaction` | Durable Object storage ([why](cloudflare.md)) | Postgres row lock, SQLite, Redis `WATCH` |
| `Drafter` | text in, JSON proposal out | Workers AI (Llama 3.3) | `OpenAICompatibleDrafter` for any OpenAI-compatible endpoint; `HeuristicDrafter` offline |
| `Lifecycle` | durable "wake me at t / when confirmed" | Workflows | Temporal, a cron + queue, in-process timers |
| `Signer` | BIP-340 Schnorr over the event id | key from Worker secret | KMS, HSM, a hardware key |
| `Clock` | `now()` in unix seconds | `Date.now` | — |
| `Notifier` (optional) | wake a paired approver app | Queues, then an empty POST to the app's wake URL | a relay subscription, a push gateway, a webhook |

Around the ports, `apps/worker` uses the rest of Cloudflare where it fits:

- **Identity.** Cloudflare Access can stand in for the owner token: a valid Access JWT for the application picks the
  person's okayed, derived from their Access identity. Remote MCP clients get OAuth from the Workers OAuth Provider
  (KV), with consent on okayed's own Connect screen; each client becomes one agent.
- **Abuse.** Turnstile on sign-up; the Workers rate-limiting binding on sign-ups and on each agent's requests.
- **Observability.** Workers Logs, Analytics Engine data points for each request, issue and deploy, and AI Gateway
  for model calls.
- **Least privilege for real actions.** A deploy mints an account API token with only Pages Write, valid until the
  grant expires (ten minutes at most), uses it once and deletes it. The standing secret can only mint tokens.

`packages/core` ships in-memory adapters, and its tests run the whole flow (request, propose, confirm, issue,
verify, second use refused, revoke, expire) in Node.

## Identity, approvers and assurance (v0)

A user is a Durable Object named by a random id. The person's browser holds an owner token, and agents get bearer
tokens minted from the web app. Grants are signed with a per-user key derived from the service secret
(HKDF(secret, user id)), so `iss` differs per user and can be pinned by verifiers.

**Approvers** are where the person says yes. Every approver signs the same **binding**: `{v, card, draft, nonce}`,
where `draft` is `sha256(JCS(the exact draft))`. The binding's JCS hash is the challenge, so a proof can only okay
that exact draft.

- **Local: a passkey.** The browser asks for the challenge and returns a WebAuthn assertion (Face ID, Touch ID,
  Windows Hello, a security key).
- **Pushed: a paired app on another device.** The person pairs the app's BIP-340 public key. When a card waits,
  okayed keeps it in the person's inbox, bound to a fresh nonce, and may wake the app through the `Notifier` port
  (the wake carries nothing). The app reads its inbox with a NIP-98 signed request, shows the card, and answers with
  an approval event (kind 4845) signed by its own key. okayed checks the signature, that the key is paired, and that
  the binding is the one it's waiting on, and that the draft hasn't changed. The transport is never trusted.

`assurance` records how the person confirmed:

- `policy`: a rule allowed it, and `assurance.policy` names the rules and limits it drew on.
- `webauthn`: a passkey. The assertion, the binding and the public key ride on the grant as `assurance.proof`.
- `approver`: a paired app. Its signed answer and public key ride on the grant as `assurance.proof`.
- `web-click`: a plain tap, where the browser has no passkey.

A hardware key fits the passkey slot, and any app that can hold a key can be a pushed approver.

## The demo agent

`OkayedChat` is an Agents SDK `AIChatAgent` per person: an assistant with simulated tools. AI SDK tool approval hands
every tool call to okayed:

- allowed by policy → `approved`
- asks → `user-approval`, and the chat shows okayed's card
- refused → `denied`

The tool's `execute` then looks up the grant and spends it, so an approval the client claims without a grant does
nothing. Offline, a scripted model plays the assistant by reading intent with okayed's own anchors.

## Interpreting people

The model has one job before the engine: read the person. Some of that is open-ended (turn "merge #182 once CI
passes, for 5 minutes" into a draft), and some is a bounded choice:

- Is this an okay, a rule, or neither?
- Which pending request does "that one" mean?
- Which site, which environment?

The engine already answers the last two deterministically, or asks. A model only has to get close.

`packages/core/test/interpret.test.ts` scores drafters on twenty cases, from plain okays to prompt injections. It
counts the intent (the bounded choice) on its own, and the outcome, which is what the engine ends up doing with the
draft: the right grant, the right rule, a question, or nothing. A weak model can't widen anything, so it shows up as
needless questions and missed meaning. The heuristic runs on every test run and guards a baseline. With credentials,
`EVAL_MODELS` runs Workers AI models (Llama 3.3, gpt-oss), OpenAI, or any OpenAI-compatible endpoint side by side.

Fast decision models fit the bounded part. OpenAI's Decisions API answers a question from a fixed set of options in
one call, reportedly in about 150 ms. Jev is similar. Either could pick the intent and the request without drafting
JSON. Neither is wired in yet: their API references couldn't be checked from this build environment, and each is a
paid external service. The place for one is a drafter that asks the bounded questions and leaves the rest to the
engine, scored by the same evals.

## How it fits

- **OpenMeadow** asks who an agent acts for, what it can touch, and how you take it back. okayed answers that one
  grant at a time, and its format is plain enough to show in a Meadow UI.
- **Nostr relays** can carry okayed's events as they are: they are ordinary signed events on placeholder kinds
  (4840–4845, 34840) with NIP-40 expiration.
- **Agents** connect over MCP (`apps/mcp`) or the client (`packages/client`): `POST /requests` before a merge or
  deploy, then the grant goes to the tool. No GitHub token reaches the agent.

## Out of scope for v0

Multi-act grants, delegation chains, payment rails, real user accounts, and relay publication. Events are stored and
can be fetched as Nostr JSON, but are not pushed to relays.
