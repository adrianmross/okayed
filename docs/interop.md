# okayed and other permission systems

Every permission system answers the same three questions: **what** can be done (capabilities), **to what**
(resources), and **by whom** (principals). okayed's answers are actions (`github.pr.merge`), exact resources
(`github:acme/web/pull/7@3f9a1c2`), and the person with their agents and approvers. `@okayed/interop` maps the
vocabularies already in use onto those, so okayed works alongside them rather than as another silo:

| | okayed | OAuth 2.0 / OIDC | SAML | SCIM | UCAN |
|---|---|---|---|---|---|
| **What** | action | scope; RAR `actions` | role, entitlement | `roles`, `entitlements` | command (`/github/pr/merge`) |
| **To what** | exact resource | RAR `identifier`, `locations` | — | — | subject, plus a policy on arguments |
| **By whom** | person, agent, approver | `sub`, `groups`, `roles` claims | NameID, group attributes | Users, Groups | `iss`, `aud` DIDs |
| **For how long** | `exp`, uses | token lifetime | session | while active | `exp`, `nbf` |

It's a separate package because none of it is needed to run okayed, and the core shouldn't grow every standard's
quirks. The core gains only two general hooks it uses: **limits from outside the person** (`setCeiling`) and
**agent groups** (`group:<name>` in rules), plus a `readRequest` hook for requests in other formats.

## Limits from outside the person

okayed decides in layers, and the strictest layer wins. The person's own rules are one layer. `setCeiling(id, layer)`
puts another above it: an organization's policy, a token's scopes, a regulator's. Because the strictest layer wins,
a limit can only narrow:

- A limit that **blocks** something blocks it, whatever the person's rules say.
- A limit that **allows** something leaves it to the person. Their rules still decide, and they still okay each
  thing (or make a rule for it).
- A limit that **asks** insists on a person, even where their rules would let it go ahead.

Only the deployment sets limits. The person's API has no route for them. The web app shows them read-only, above the
person's rules, as "Set by Acme".

## An organization's policy, from its groups

An `OrgPolicy` says what each group's agents may do:

```json
{
  "name": "Acme",
  "default": "deny",
  "grants": [
    { "to": "*", "effect": "allow", "act": "github.read" },
    { "to": "release-managers", "effect": "allow", "act": "github.pr.merge", "res": "github:acme/**" },
    { "to": "role:deployer", "effect": "allow", "act": "site.deploy", "res": "site:*/staging" },
    { "to": "role:deployer", "effect": "ask", "act": "site.deploy", "res": "site:*/production" }
  ]
}
```

`ceilingFor(principal, policy)` gives each person the part that applies to them. Set it as `ORG_POLICY` (Worker or
Node). Where the groups come from is up to the deployment:

| Source | How groups arrive | When limits update | Removing someone |
|---|---|---|---|
| **SCIM** (Okta, Microsoft Entra, Google, JumpCloud…) | the IdP provisions Users and Groups at `/scim/v2` | the moment the IdP sends a change | stops their okayed: every permission their agents hold is taken back, and new ones are blocked |
| **OIDC groups claim** | the `groups` or `roles` claim in their sign-in token (Okta, Entra, Auth0, Keycloak…) | at each sign-in | when their next sign-in fails |
| **Cloudflare Access** | Access's identity for the session, with groups from any IdP behind it, SAML included | at each sign-in | when Access stops letting them in |
| **SAML, directly** | attributes from an assertion a SAML library has verified (`fromSamlAssertion`) | when you call it | your call |

With a SCIM token set, the directory is the one source, and sign-in doesn't change limits.

### Setting up SCIM

1. Set a long random `SCIM_TOKEN` (`wrangler secret put SCIM_TOKEN`, or the env var on Node).
2. In the IdP, add a SCIM 2.0 app with base URL `https://<your okayed>/scim/v2`, bearer token auth with that token,
   and push users and groups.
3. Tell okayed which SCIM attribute holds the subject the IdP puts in its sign-in tokens: `SCIM_SUBJECT=externalId`
   (default), `userName` or `id`. That's how a directory user finds their okayed, which is keyed by the sign-in
   issuer and subject. Map the IdP's user id into `externalId` and it lines up.

The endpoint implements what IdPs use: Users and Groups with create, read, replace, PATCH (including Entra's
`"False"` strings and `emails[type eq "work"].value` paths, and Okta's path-less replaces) and delete, `eq`-style
filters joined by `and`, paging, `excludedAttributes=members`, and the discovery endpoints. It doesn't implement
bulk, sorting, ETags or `or` filters.

On Cloudflare, the directory is its own Durable Object (`OkayedDirectory`): one writer for who's in which group. On
each change it reaches into each affected person's object by name. That works even before they've signed in, so
their first session already has their limits. See [cloudflare.md](cloudflare.md).

## Agent groups

An agent can be in groups (`PUT /api/u/:user/agents/:agent/groups { "groups": ["deployers"] }`). A rule or limit
naming `group:deployers` covers every agent in it. That's how a rule reads "agents in deployers may deploy to staging"
instead of listing them, and how an organization's grant can be just for its CI agents.

## OAuth 2.0 scopes

A `ScopeDef` says what a scope covers in okayed's terms, values included:

```ts
{ scope: "deploy:{env}", allows: [{ act: "site.deploy", res: "site:*/{env}" }] }
```

- `scopeCeiling("repo deploy:staging", defs, { agent })`: a token's scopes as a limit on one agent. What they cover
  is left to the person, and everything else is blocked.
- `scopesFor(act, res, defs)`: the narrowest scopes a credential for one grant needs, for asking an authorization
  server for exactly that much.
- A scope's value can only be a plain name: `deploy:*` or `deploy:a/b` match nothing, so a token can't widen what
  its scope names.

Presets: `GITHUB_SCOPES` (`repo`), `SLACK_SCOPES` (`chat:write`), `SITE_SCOPES` (`deploy:{env}`), and
`actionScopes()` (okayed's own actions as scopes).

## Rich Authorization Requests (RFC 9396)

RFC 9396's `authorization_details` is OAuth's way to ask for something finer than a scope, and okayed's requests fit
it: one action on exact resources.

- **In:** an agent may file a request as `{ "authorization_details": [...], "why": "…" }`. The Worker and Node read
  it with `readRichRequests()`. okayed's own type is `{ "type": "okayed", "actions": [act], "identifier": res }`.
  Readers can add other types: `paymentInitiation({ account })` reads RFC 9396's own example as spending up to its
  amount. A detail no reader understands is refused, never skipped. Skipping would okay less than was asked, and
  make it look like more.
- **Out:** `detailsForGrant(grant)` writes a grant as `authorization_details`, with its id, issuer, expiry and uses.
  An authorization server can put that in an access token (RFC 9068), so a resource server that knows RAR enforces
  exactly what was okayed.

## UCAN

UCAN 1.0 delegations are capability tokens that delegate a command on a subject, bounded by a policy over the
invocation's arguments. They're the closest thing in the wild to an okayed grant:

- The person's issuer key is a secp256k1 `did:key` (`didKey(issuer)`, with `zQ3s…`).
- An action is a command: `github.pr.merge` is `/github/pr/merge`.
- Exact resources are a policy: `[["==", ".res", "github:acme/web/pull/7@…"]]`, or an `or` of those.
- `ucanForGrant(grant, { audience })` and `requestFromUcan(delegation)` go each way. Reading accepts only exact
  policies. A glob or a powerline (`sub: null`) is refused, never approximated into something wider.

What doesn't map: use counts (UCANs are stateless, so "once" needs the issuer to see each use) and okayed's
conditions, which ride in `meta`. These are payloads. Signing the UCAN envelope (DAG-CBOR with a varsig) is a UCAN
library's job.

## Principals

Every source reads into one `Principal`: a stable id (`oidc:<iss>#<sub>`, `saml:<idp>#<nameid>`, `scim:<id>`), groups
and roles (lowercase; an LDAP DN by its common name), OAuth scopes, and whether they're active. `fromOidcClaims`,
`fromSamlAssertion`, `fromAccessIdentity` and `principalFromScim` cover the common claim and attribute names (Okta,
Entra, AD FS, Auth0, Keycloak, Google, eduPerson). Pass your own names when yours differ.

## What isn't here yet

- **SAML XML signatures.** okayed doesn't verify them. Put Cloudflare Access (or another SAML-to-OIDC broker) in
  front, or use a SAML library and hand okayed what it read.
- **UCAN envelopes.** okayed maps payloads only.
- **Relationship-based authorization** (Zanzibar, OpenFGA, SpiceDB). This would fit as a grant condition a
  connector checks ("`user:ada` is `editor` of `doc:x`"), using the same facts mechanism `checks.pass` uses.
- **Cedar and IAM-style policies.** An organization's policy could be written in Cedar and compiled to an
  `OrgPolicy` layer, or checked as one more layer at decision time.
- **Scopes for remote MCP clients.** okayed's own OAuth server offers one scope today. Offering `actionScopes()` would
  let a client be authorized for, say, only `github.read`, as a limit on its agent.
