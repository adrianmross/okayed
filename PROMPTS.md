# Prompt history

okayed's design is mine: the problem, the grant format, the layered engine, and the rule that a model only drafts while
a deterministic engine decides. Several ideas, like hold-and-slide to choose how long an approval lasts, come from my
earlier work on unreleased projects (shown as [redacted]).

I built it with an AI coding assistant (Claude Code), which the Cloudflare assignment encourages and asks to see. These
are the larger prompts, lightly edited: spelling fixed, and side questions and project setup left out. Each is followed
by the commits that came of it. Along the way I made the product and design calls, used each build as it shipped, and
reviewed the work before merging it. The prompts okayed itself sends to Llama 3.3 are in
[`packages/core/src/prompts.ts`](packages/core/src/prompts.ts).

## 1. The problem and the ground rules

The opening brief was one prompt; it's split here by the stage of work each part drove.

```text
okayed: a scoped-authority approval service for AI agents, on Cloudflare.

The problem: people tell their agents things like "I approve merging #182" or "go ahead and deploy the website".
That sentence is not an authorization anything can verify. okayed turns it into the narrowest exact, signed,
expiring grant, shows it to the person for confirmation, and lets any tool verify the grant before acting.

Requirements: Llama 3.3 on Workers AI; the Agents SDK with a Durable Object per user and a Workflow for the grant
lifecycle; a chat UI; per-user policy, pending requests, active grants and an audit log in the Durable Object.

Design rules:
- The model drafts; a deterministic engine decides. The LLM only turns plain language into a proposed grant and
  explains requests and decisions. Allow/deny and narrowing are pure, tested TypeScript.
- Least privilege by construction: grants pin exact targets (repo + PR + commit SHA; site + environment), the
  shortest reasonable lifetime and the fewest uses. The engine refuses anything broader than what the person said,
  and shows what it cut ("asked for X, granted Y, refused Z because ...").
- Ambiguity is a question, not a guess ("which site?", "which environment?").
- "Once" means exactly one use: the Durable Object decrements atomically; a second use is refused.
- Every grant is revocable at any time; expiry is enforced by the Workflow and by verifiers.

Grant format (v0, JSON, signed as a Nostr event; kinds are placeholders, not registered):
{v, id (JCS hash), iss, aud, act, res[], when[], nbf, exp, uses, risk, assurance, from{utterance, request}, nonce}.
Kinds: 4840 request, 4841 grant, 4842 revoke, 4843 use receipt, 4844 emergency stop, 34840 policy. Use NIP-40
expiration tags. assurance records how the person confirmed (a web click today; a hardware-key proof later).

Start with a short design doc and the grant format. Ask before adding any paid Cloudflare feature.
```

- `docs: add design doc and v0 grant format`

## 2. The engine

```text
packages/engine: a pure engine. Policy = layered rules, where each layer can only narrow the one above; a decision is
allowed only if every layer allows; the reason names the first layer that refuses; a "beyond" list shows what was
asked for but not granted. Plenty of unit tests, including adversarial ones where the prompt tries to widen scope.
```

- `feat(engine): add pure policy, narrowing and use-check engine with tests`
- `feat(grant): add v0 grant format with JCS ids and signed Nostr events`

## 3. The Worker

```text
apps/worker: an Agents SDK agent and a Durable Object per user; a Workflow for request -> propose -> await confirm ->
issue -> expire/revoke; an HTTP API for agents to submit requests and for tools to verify grants (POST /verify).
Cloudflare first, but design so another provider can be added later.
```

- `feat(core): add provider-neutral service, grant lifecycle flow and in-memory adapters`
- `feat(worker): add Agents SDK agent, grant lifecycle Workflow and HTTP API`
- `chore: add dev:local script for running the Worker without a login`

## 4. The two UIs

```text
apps/web: a chat to set policy in plain words ("auto-approve read-only GitHub for 1 hour; ask me before anything that
spends money"), pending requests as a clear card (a plain sentence, what it allows, what it does not, risk),
confirm/deny/revoke, and an audit view.

apps/playground: write a policy, ask a question, see allow/deny with a one-sentence reason and a per-layer breakdown,
with one-tap "what if" edits. The headline demo: plain-language approval -> proposed grant -> engine narrows it ->
diff of what was cut.
```

No paid Cloudflare features were added: Workers, Durable Objects (SQLite), Workflows, the Workers AI free allocation
and static assets are all on the free plan.

- `feat(web): add chat UI for policy, request cards, grants and audit`
- `feat(playground): add in-browser policy playground and narrowing demo`
- `docs: add README, prompt history and screenshots`

## 5. Simpler UI, cleaner code

```text
Let's simplify the web policy view the same way we did the playground and [redacted]. Clean up the code as much as
possible too. I was also expecting something more like 3-D models to explain what's happening and to visualize the
layers and steps. And the web UI looks generated, with the card highlight on the side.
```

My calls: match [redacted]'s style (one question with a Yes/No answer, flat blocks, a Debug switch), keep 3-D
explainers out of the repo, and clean up everything with behavior frozen. Checking the WebSocket turned up a fix.

- `fix(worker): refuse live-state sockets without the owner token`
- `feat(ui): add shared block components`
- `refactor(web): rebuild on shared blocks with tabs and a Debug switch`
- `refactor(playground): ask-your-policy view and words-to-grant view on shared blocks`
- `refactor(engine): split binding from narrowing and share one capping rule`
- `refactor(core): split records, card building and the snapshot view out of the service`
- `chore: flag unused code in typecheck; document the ui package`
- `docs: add code-by-layer and test-coverage chart`

## 6. Standing authority, and budgets

```text
What happens when I do want the agent to be able to merge anything, like a standing policy? Give a reasonable default
posture, but leave it to the user to create the policies they want; that's the whole point of the policy engine.
What you've built is one-time approvals shown as a policy, but a policy is for repeat actions: with an expiration,
bounded to a couple of uses, or bounded on scored risk. There are many ways to express it, and we've implemented
them across [redacted].
```

```text
Risk budgets shouldn't be on by default, and they could be global or local to single policies, actions or approvals.
```

My calls: start from a balanced posture, and keep okayed's own v0 wire format.

- `feat(engine)!: standing policies with horizons, budgets and conditions`
- `feat(core): run standing policies with budgets, statements and top-ups`
- `feat(ui): edit standing policies in place, with budgets left and top-up`
- `docs: describe standing policies`
- `feat: make budgets opt-in, on one policy or shared across policies`
- `docs: describe opt-in and shared budgets`
- `docs: bring the prompt history up to date`

## 7. A chat demo on its own design system

```text
For the demo, it should just be a standard chat where you ask for things that need permission. It doesn't actually
do anything but show the card to approve, Face ID, and approve. Different views can show receipts or transcripts.
Use the latest shadcn, and show tool calls in the chat. The UI so far is still way too complex: it needs clear,
enjoyable configuration, and it doesn't need to cram everything onto one page. Siri Shortcuts is good inspiration for
building rules. Make your own design system for this project (it can be standalone) so it feels cohesive.
```

- `feat: add an agent client and an MCP server for agents`
- `feat(design): add okayed's design system on the latest shadcn`
- `feat: add passkey approvals and a demo chat agent with simulated tools`
- `feat(web): rebuild as a chat demo with Face ID approvals and Shortcuts-style policies`
- `feat(playground): rebuild on the design system`
- `fix(core): let the scripted assistant read denials however they arrive`
- `test: run the demo end to end in a browser with a virtual Face ID`
- `docs: describe the chat demo, passkey assurance and the design system`

## 8. Everyday words, approver apps, a registry, other models

```text
Which works better, rules or policies, and grants or approvals? Anything else language-wise we could improve?
```

```text
Build it with local assurance through WebAuthn now, and an external authenticator like [redacted] later, with the
approval pushed there. Maybe we need our own shadcn registry, since that's recently supported. It would also be
interesting to try different models for the interpretation, or a decision API.
```

The app now says rules, Allow / Ask me / Block, permissions, limits and Take back; the API, grant format and docs keep
the IAM terms.

- `feat(ui): say rules and permissions, and add "Always allow…"`
- `feat(core): push approvals to approver apps on other devices`
- `feat(design): publish the design system as a shadcn registry`
- `fix(engine): keep the place in "never deploy to production"`
- `feat(core): compare interpreters on an eval set, and draft with any OpenAI-compatible model`
- `refactor: list each assurance method once, and rename a playground constant`
- `fix(ui): say "your rules" when something is allowed, and name agents properly on tiles`
- `test(e2e): wait for the assistant to finish before sending the next message`
- `docs: describe the new words, approvers, the registry and interpreter evals`

## 9. Approval buttons, and Cloudflare-native

```text
Show different button configurations in the registry: a row layout or a main action with two secondaries, and flows
like single tap or swipe to approve. For Always allow, use what worked well in [redacted]: hold the button and slide
up through how long it applies, then swipe all the way through to confirm. The same for deny. Different apps can use
different configurations and add their own on top. Let's also do all the Cloudflare work we discussed.
```

The Cloudflare work: remote MCP with OAuth, Access sign-in, one Worker serving everything, AI Gateway, Turnstile, rate
limits, Analytics Engine, Queues, an R2 archive, Whisper voice and real deploys with just-in-time tokens.

- `feat(design): approval actions in layouts and flows, with slide and hold-and-slide`
- `feat(playground): show every approval configuration in a Components view`
- `feat(core): a Deployer port, and wake URLs for paired approver apps`
- `feat(worker): run okayed as one Cloudflare-native Worker`
- `feat(web): approval buttons, timed rules, voice, and the Connect screen`
- `test: OAuth and MCP end to end, queue and archive checks, hold and slide in the browser`
- `docs: describe okayed on Cloudflare end to end, and the approval buttons`

## 10. A platform-neutral core

```text
Keep the core platform-agnostic, so we can hook this up to many things and approve a wide range of capabilities and
actions with different auth flows.
```

- `feat: make the core platform-neutral: identity, connectors and the HTTP API`
- `feat(engine): capability packs, so any service's actions can be approved`
- `feat(design): show registered actions with the engine's words`
- `feat(node): run okayed on Node, from the same core`
- `feat: approve any service's actions, end to end`
- `feat(web): trust a CI workflow, and work with any registered action`
- `docs: describe the platform-neutral core: runtimes, packs, connectors, identity`

## 11. Other permission systems

```text
Add more to the docs on the Cloudflare integration and architecture. For capabilities, integrate OAuth/OpenID scopes,
SAML or SCIM groups, UCAN and other permission systems, maybe as another package, and the same for resources and
principals.
```

- `feat(engine): rules and limits for groups of agents`
- `feat(core): limits from outside the person, and agent groups`
- `feat(interop): OAuth scopes, rich authorization requests, UCAN, SCIM and organization policies`
- `feat: organization limits and SCIM provisioning on the Worker and on Node`
- `feat(web): show an organization's limits above your rules`
- `docs: Durable Objects, Cloudflare, and other permission systems`

## 12. Swipe to decide, and a quieter chat

It came with a screenshot of an approval card from that earlier work.

```text
The chat still isn't streamlined enough: too many cards, when those should go to the transcript or receipts. This is
how we showed the card in [redacted], and closer to it looks better, especially holding to choose a duration. Look at
how it's done in that code, and the same for the swipe actions and payments. Take the best of each, or let it be
adapted slightly.
```

- `feat(design): swipe to decide, with a tested gesture model`
- `feat(design): the approval card asks in plain words, and payments are money cards`
- `feat(core): the demo assistant replies in one line, and gives its reasons in its own words`
- `feat(web): one line per action, and swipe everywhere`
- `feat(playground): every swipe configuration, payments included`
- `chore(mcp): keep the CLI executable`
- `test: drive the browser test by swipe and hold`
- `docs: swipe to decide, money cards and a quieter chat`

## 13. Live, and open to the public

CI and the deploy, then what showed up once it ran on the real Workers AI and I used it:

```text
Since this is public, how do I make sure people don't abuse it?
```

```text
If I go to another page and back to the chat, it stops replying.
```

- `ci: add test, end-to-end and deploy workflows`
- `fix(worker): simulate streaming so Workers AI tool calls arrive whole`
- `docs: link the deployed demo and playground`
- `fix(worker): let the live assistant answer after a tool, and take amounts as strings`
- `feat(worker): limit model calls per person`
- `fix(web): no flash when a rule allows an action`
- `fix(web): keep the chat mounted on other pages`
- `fix(web): leave rule-approved tool calls to the server`
- `fix(web): show the saved chat after a reload`
- `fix(core): the assistant chats, asks for a missing repo and takes "prod"`
- `fix(design): the swipe holds while Face ID and signing run`

## 14. Sign-in, organizations, and who signs what

```text
There should be separate resets for the whole demo and for just the chat. And where's the non-demo part of the work?
The playground should showcase OAuth2/OIDC integration more, with sign-in providers and organizations, to show how
this connects in an enterprise.
```

```text
Make the providers a sign-in screen with their logos, and show ids and keys the same way as the Nostr signing. We need
a holistic picture.
```

```text
If the passkey isn't set up and you ask the chat for something that needs it, it says "working" forever.
```

- `feat(web): reset the chat or the whole demo from Settings`
- `feat(playground): show sign-in providers, org limits and OAuth scopes`
- `feat(web): Reset chat sits in the chat header`
- `feat(design): one KeyChip for ids and keys, used in receipts and Settings`
- `feat(playground): a sign-in screen with provider logos and who signs what`
- `test(e2e): read receipt ids in their KeyChip form`
- `fix(web): a passkey prompt that never answers no longer hangs the approval`
