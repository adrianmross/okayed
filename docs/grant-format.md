# okayed grant format, v0

Status: draft. The event kinds are **placeholders and not registered** with the NIPs repository. They may change.

A grant is a JSON object signed as a Nostr event ([NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)).
It carries an [NIP-40](https://github.com/nostr-protocol/nips/blob/master/40.md) `expiration` tag, so relays and
clients that know nothing about okayed still drop it once it expires.

## Kinds

| Kind | Name | Content | Notes |
|---|---|---|---|
| 4840 | request | `Request` | An agent asks to do one thing. |
| 4841 | grant | `Grant` | The person (or their policy) said yes, narrowly. |
| 4842 | revoke | `Revoke` | Stops a grant before `exp`. |
| 4843 | use receipt | `UseReceipt` | One use of a grant was spent. |
| 4844 | emergency stop | `Stop` | Revokes every live grant and pauses auto-approval. |
| 34840 | policy | `Policy` | Addressable (`d` = `"policy"`); the newest revision wins. |

Every event's `content` is the [JCS](https://www.rfc-editor.org/rfc/rfc8785) serialization of its object, and its
`pubkey` is the issuer key (`iss`).

## Grant

```json
{
  "v": 0,
  "id": "9f2c…",
  "iss": "4b1e…",
  "aud": "agent:assistant",
  "act": "github.pr.merge",
  "res": ["github:adrianmross/okayed/pull/182@3f9a1c2e4b5d6f708192a3b4c5d6e7f801234567"],
  "when": [{ "c": "checks.pass" }],
  "nbf": 1761735600,
  "exp": 1761736500,
  "uses": 1,
  "risk": "high",
  "assurance": { "method": "web-click", "at": 1761735598 },
  "from": { "utterance": "I approve merging #182 once CI passes", "request": "r_7d1e…" },
  "nonce": "b3a9e0f1c2d34e5f"
}
```

| Field | Type | Meaning |
|---|---|---|
| `v` | `0` | Format version. Verifiers refuse versions they don't know. |
| `id` | hex(32) | `sha256(JCS(grant without "id"))`. Names the grant everywhere: revokes, receipts, use counters. |
| `iss` | hex(32) | BIP-340 x-only public key of the issuer. Equals the event `pubkey`. |
| `aud` | string | Who may use it, e.g. `agent:<id>`. One audience per grant. |
| `act` | string | Exactly one action from the catalog (below). No wildcards. |
| `res` | string[] | Exact resources (grammar below). No wildcards; at least one. The use must name one of them. |
| `when` | `{c, v?}[]` | Extra conditions, all of which must hold. Verifiers **refuse** a use whose conditions they cannot evaluate. |
| `nbf` | unix s | Not valid before. |
| `exp` | unix s | Not valid at or after. Must also be the `expiration` tag. |
| `uses` | int ≥ 1 | How many times it may be used. There is no "unlimited". |
| `risk` | `low` \| `medium` \| `high` \| `critical` | Computed by the engine, not by the model. |
| `assurance` | `{method, at, proof?, policy?}` | How the person confirmed: `web-click` today, later `webauthn` or `approver` with `proof`. For `policy` (auto-approved by a standing policy), `policy` lists the rules that allowed it and the shared budgets it drew on (`budget:<id>`). |
| `from` | `{utterance, request}` | The person's words, and the request id it answers (`null` for a pre-approval). For audit only; never used to decide. |
| `nonce` | hex(8+) | Makes otherwise identical grants distinct. |

### Event

```json
{
  "kind": 4841,
  "pubkey": "<iss>",
  "created_at": 1761735600,
  "tags": [
    ["x", "<grant id>"],
    ["act", "github.pr.merge"],
    ["aud", "agent:assistant"],
    ["expiration", "1761736500"]
  ],
  "content": "<JCS(grant)>",
  "id": "<NIP-01 event id>",
  "sig": "<BIP-340 signature>"
}
```

## Resources

Resources are URIs with a small grammar. Grants use only **exact** forms. Policy rules may also use patterns: `*`
matches one path segment and `**` matches the rest.

| Resource | Form | Example |
|---|---|---|
| GitHub repository | `github:<owner>/<repo>` | `github:adrianmross/okayed` |
| GitHub pull request at a commit | `github:<owner>/<repo>/pull/<n>@<sha40>` | `github:adrianmross/okayed/pull/182@3f9a…` |
| Site environment | `site:<host>/<env>` | `site:openmeadow.org/production` |
| Money | `money:<account>/<currency>/<max>` | `money:card-1/USD/20` |

A merge grant must pin the head commit. If the PR moves, the grant no longer matches, and GitHub's merge API
refuses it as well (`sha` parameter).

## Actions (v0 catalog)

| Action | Resource | Base risk | Default life / max | Default uses |
|---|---|---|---|---|
| `github.read` | repo or PR | low | 1 h / 8 h | 50 |
| `github.pr.comment` | PR | medium | 30 min / 2 h | 1 |
| `github.pr.merge` | PR at commit | high | 15 min / 1 h | 1 |
| `site.deploy` | site env | medium (`production`: high) | 30 min / 2 h | 1 |
| `spend.money` | money | critical | 10 min / 30 min | 1 |

## Conditions

| `c` | `v` | Holds when |
|---|---|---|
| `checks.pass` | — | The pinned commit's required checks are green (the verifier asks GitHub). |
| `before` | unix s | Now is before `v` (a tighter cut-off than `exp`). |

## Passkey assurance

When the person approves with a passkey, `assurance` is:

```json
{
  "method": "webauthn",
  "at": 1761735598,
  "proof": {
    "credential": "<credential id, base64url>",
    "publicKey": "<COSE public key, base64url>",
    "rpID": "okayed.pages.dev",
    "origin": "https://okayed.pages.dev",
    "binding": { "v": 0, "card": "c_…", "draft": "<sha256(JCS(draft))>", "nonce": "…" },
    "response": { "clientDataJSON": "…", "authenticatorData": "…", "signature": "…" }
  }
}
```

To check it:

1. Recompute the challenge as `base64url(sha256(JCS(binding)))`. It must equal `clientDataJSON.challenge`.
2. Check `binding.draft` against the grant: the draft is the grant without `id`, `iss`, `assurance`, `nonce` and
   `v`, and with `nbf`/`exp` as proposed.
3. Verify the signature over `authenticatorData || sha256(clientDataJSON)` with `publicKey`, with user verification
   required.

## Other objects

```ts
Request    { v: 0, id, aud, act, res: string[], why: string, at, exp }
Revoke     { v: 0, grant: id, reason: string, at }
UseReceipt { v: 0, grant: id, use: n, left: n, act, res, at }
Stop       { v: 0, reason: string, at }
Policy     { v: 0, layers: [{ name, default: "allow" | "ask" | "deny" | "abstain", rules: Rule[] }], budgets?: SharedBudget[], at }
SharedBudget { id, uses?, risk?, scope?: { act?, res?, agent? }, counts?: "auto" | "all", until?, note? }
Rule       { id, effect: "allow" | "ask" | "deny", act, res?, agent?,
             from?, until?,                  // horizon
             budget?: { uses?, risk? },      // totals across auto-approvals
             when?: Condition[],             // carried by every grant issued under it
             maxTtl?, maxUses?,              // caps on each grant
             note? }
```

Risk costs for budgets: `low` 1, `medium` 3, `high` 8, `critical` 20. A policy event (kind 34840) is signed whenever
the person's rules change. What each rule has spent is service state, not part of any event.

```
```

## Verifying a use

A verifier checks all of these, in order, and refuses on the first failure:

1. The event signature is valid, `kind == 4841`, `pubkey == grant.iss`, and `iss` is a key it trusts for this user.
2. `id == sha256(JCS(grant without id))`, `v == 0`, and the `expiration` tag equals `exp`.
3. `nbf <= now < exp`.
4. `aud` is the caller, `act` equals the requested action exactly, and the requested resource is one of `res`
   exactly.
5. Every `when` condition is known and holds.
6. The grant is not revoked and no emergency stop came after it, which only the issuer knows: ask `POST /verify`.
7. Spending a use is atomic at the issuer (`POST /verify` with `"consume": true`), which returns a 4843 receipt.

Checks 1–5 can run offline. Checks 6 and 7 need the issuer.
