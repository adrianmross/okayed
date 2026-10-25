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
- **From words.** "let assistant merge anything in okayed when checks pass for 2 weeks, up to 30 merges" becomes a
  standing policy with an agent, a repo scope, a condition, a horizon and a count. The model's draft can't widen any
  of these. How open-ended a policy is stays the person's call.

## Components

```
                 ┌─────────────── apps/web (Pages) ───────────────┐
 person ──chat──▶│ policy in plain words · request cards · audit  │
                 └───────────────┬────────────────────────────────┘
                                 │ WebSocket (Agents SDK) + HTTP
 agent ──POST /requests──▶ ┌─────▼──────────────────────────────┐   ┌──────────────┐
                           │ apps/worker                        │──▶│ Workers AI   │
 tool ──POST /verify────▶  │  OkayedAgent (Durable Object/user) │   │ Llama 3.3    │
                           │   policy · requests · grants ·     │   └──────────────┘
                           │   audit · use counters             │
                           │  GrantLifecycle (Workflow)         │
                           │   propose → await confirm → issue  │
                           │   → sleep until exp → expire       │
                           │  /tools/github/merge (holds token) │──▶ GitHub API
                           └─────┬──────────────────────────────┘
                                 │ imports
          packages/core ── service logic behind ports (Store, Signer, Drafter, Lifecycle, Vault, Clock)
          packages/engine ─ pure: catalog, resources, anchors, policy, narrowing, use checks
          packages/grant ── format: JCS, ids, Nostr events, signatures
```

## Provider-agnostic by design

Cloudflare comes first, but only `apps/worker` imports Cloudflare APIs. Everything else goes through ports defined
in `packages/core`:

| Port | What it needs | Cloudflare adapter | Elsewhere |
|---|---|---|---|
| `Store` | per-user key/value with a serializable `transaction` | Durable Object storage | Postgres row lock, SQLite, Redis `WATCH` |
| `Drafter` | text in, JSON proposal out | Workers AI (Llama 3.3) | any chat model; `HeuristicDrafter` offline |
| `Lifecycle` | durable "wake me at t / when confirmed" | Workflows | Temporal, a cron + queue, in-process timers |
| `Signer` | BIP-340 Schnorr over the event id | key from Worker secret | KMS, HSM, a hardware key |
| `Vault` | swap a grant for a real credential | Worker secret | Vault, Secrets Manager |
| `Clock` | `now()` in unix seconds | `Date.now` | — |

`packages/core` ships in-memory adapters, and its tests run the whole flow (request, propose, confirm, issue,
verify, second use refused, revoke, expire) in Node.

## Identity (v0)

A user is a Durable Object named by a random id. The person's browser holds an owner token, and their agents get
bearer tokens minted from the web UI. Grants are signed with a per-user key derived from the service secret
(HKDF(secret, user id)), so `iss` differs per user and can be pinned by verifiers. `assurance` records how the
person confirmed: `web-click` or `policy` today. A WebAuthn or hardware-key proof (`webauthn`, `approver`) can be
added without changing the format.

## How it fits with the rest of our stack

- **OpenMeadow** asks who an agent acts for, what it can touch, and how you take it back. okayed answers that one
  grant at a time, and its format is plain enough to show in a Meadow UI.
- **Nostr relays** can carry okayed's events as they are: ordinary signed events on placeholder kinds
  (4840–4844, 34840), and `assurance` can carry a proof from an approver app.
- **Assistant.** Assistant can be the first agent on okayed: `POST /requests` before a merge or deploy, then pass the grant to
  the tool gateway. No GitHub token ever reaches Assistant.

## Out of scope for v0

Multi-act grants, delegation chains, payment rails, real user accounts, and relay publication. Events are stored and
can be fetched as Nostr JSON, but are not pushed to relays.
