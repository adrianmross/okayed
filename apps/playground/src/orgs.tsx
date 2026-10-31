import { ActionTile, AgentAvatar, PHRASE } from "@okayed/design/okayed";
import { Textarea } from "@okayed/design/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@okayed/design/ui/toggle-group";
import { DEFAULT_POSTURE, decideAll, labelRes, personalLayer, type Layer } from "@okayed/engine";
import { GITHUB_SCOPES, SITE_SCOPES, SLACK_SCOPES, ceilingFor, checkOrgPolicy, detailsForGrant, fromOidcClaims, scopeCeiling, type OrgPolicy } from "@okayed/interop";
import { userForSubject } from "@okayed/core";
import { buildGrant, bytesToHex, deriveIssuerKey, grantEvent, publicKeyOf, sha256Hex, type NostrEvent } from "@okayed/grant";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { WORD, WORD_CLS } from "./ask";
import { NOW, SHA } from "./data";
import { IdentityCard, SignInScreen, type Provider } from "./identity";

/** The same policy as docs/interop.md: what Acme's groups may have their agents do. */
const ACME: OrgPolicy = {
  name: "Acme",
  default: "deny",
  grants: [
    { to: "*", effect: "allow", act: "github.read" },
    { to: "*", effect: "allow", act: "github.pr.comment", res: "github:acme/**" },
    { to: "release-managers", effect: "allow", act: "github.pr.merge", res: "github:acme/**" },
    { to: "role:deployer", effect: "allow", act: "site.deploy", res: "site:*/staging" },
    { to: "role:deployer", effect: "ask", act: "site.deploy", res: "site:*/production" },
  ],
};

/** Where each provider puts groups and roles in its ID token. okayed reads them all into one shape. */
const PROVIDERS: (Provider & { claims: (p: Person) => Record<string, unknown>; note: string })[] = [
  { id: "okta", name: "Okta", mark: "okta", iss: "https://acme.okta.com", claims: (p) => ({ email: p.email, name: p.name, groups: p.groups, roles: p.roles }), note: "Groups in a groups claim you add to the authorization server." },
  { id: "entra", name: "Microsoft Entra ID", mark: "microsoft", iss: "https://login.microsoftonline.com/acme-tenant/v2.0", claims: (p) => ({ preferred_username: p.email, name: p.name, groups: p.groups, roles: p.roles }), note: "Groups and app roles in the token; directory groups can also arrive over SCIM." },
  { id: "google", name: "Google Workspace", mark: "google", iss: "https://accounts.google.com", claims: (p) => ({ email: p.email, name: p.name, hd: "acme.com" }), note: "Google's ID token has no groups, so they arrive over SCIM instead. Without SCIM, Acme's “everyone” grants still apply." },
  { id: "keycloak", name: "Keycloak", mark: "keycloak", iss: "https://sso.acme.com/realms/acme", claims: (p) => ({ email: p.email, name: p.name, groups: p.groups.map((g) => `/${g}`), realm_access: { roles: p.roles } }), note: "Realm roles nest under realm_access.roles; okayed reads dotted claim paths." },
  { id: "auth0", name: "Auth0", mark: "auth0", iss: "https://acme.us.auth0.com/", claims: (p) => ({ email: p.email, name: p.name, "https://acme.com/groups": p.groups, "https://acme.com/roles": p.roles }), note: "Auth0 namespaces custom claims; tell okayed where with ClaimNames, or groups arrive over SCIM." },
  { id: "access", name: "Cloudflare Access", mark: "cloudflare", iss: "https://acme.cloudflareaccess.com", claims: (p) => ({ email: p.email, name: p.name, groups: p.groups }), note: "Access sits in front of okayed with any IdP behind it, SAML included, and okayed reads its identity." },
];

interface Person {
  name: string;
  email: string;
  groups: string[];
  roles: string[];
  /** Turned off by SCIM: the directory removed or deactivated them. */
  active: boolean;
}

const PEOPLE: Person[] = [
  { name: "Dana Kim", email: "dana@acme.com", groups: ["engineering", "release-managers"], roles: [], active: true },
  { name: "Sam Ortiz", email: "sam@acme.com", groups: ["engineering"], roles: ["deployer"], active: true },
  { name: "Alex Chen", email: "alex@acme.com", groups: ["contractors"], roles: [], active: true },
  { name: "Jo Patel", email: "jo@acme.com", groups: ["engineering", "release-managers"], roles: ["deployer"], active: false },
];

const PR = `github:acme/web/pull/7@${SHA}`;
const QUESTIONS: { act: string; res: string; label: string }[] = [
  { act: "github.read", res: "github:acme/web", label: "Read acme/web" },
  { act: "github.pr.merge", res: PR, label: "Merge PR #7 in acme/web" },
  { act: "site.deploy", res: "site:acme.com/staging", label: "Deploy acme.com to staging" },
  { act: "site.deploy", res: "site:acme.com/production", label: "Deploy acme.com to production" },
  { act: "spend.money", res: "money:card-1/USD/20", label: "Spend $20" },
];

/** OAuth scopes an MCP client's token might carry, and what each covers in okayed's terms. */
const SCOPES = ["repo", "deploy:staging", "deploy:production", "chat:write"];
const SCOPE_DEFS = [...GITHUB_SCOPES, ...SITE_SCOPES, ...SLACK_SCOPES];
const AGENT = "agent:claude";

/** How a company's sign-in, directory and OAuth clients plug in: every answer from okayed's engine and interop code. */
export function OrgsView() {
  const [provider, setProvider] = useState(PROVIDERS[0]!.id);
  const [who, setWho] = useState(PEOPLE[0]!.email);
  const [policyText, setPolicyText] = useState(JSON.stringify(ACME, null, 2));
  const [scopes, setScopes] = useState<string[]>(["repo", "deploy:staging"]);

  const idp = PROVIDERS.find((p) => p.id === provider)!;
  const person = PEOPLE.find((p) => p.email === who)!;
  const claims = { iss: idp.iss, sub: `00u${person.email.split("@")[0]}`, aud: "okayed", ...idp.claims(person) };
  const principal = { ...fromOidcClaims(claims), active: person.active };

  let org: OrgPolicy | null = null;
  let problems: string[] = [];
  try {
    const x = JSON.parse(policyText) as unknown;
    problems = checkOrgPolicy(x);
    if (!problems.length) org = x as OrgPolicy;
  } catch {
    problems = ["isn't valid JSON"];
  }
  const ceiling: Layer | null = org ? ceilingFor(principal, org) : null;
  const tokenLayer = scopeCeiling(scopes, SCOPE_DEFS, { agent: AGENT, name: "the agent's OAuth token" });
  const mine = personalLayer(DEFAULT_POSTURE);

  // Real keys, made in this browser: the deployment's secret, and the keys each device and app would hold.
  const keys = useMemo(() => {
    const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
    return { secret: rand(32), approver: publicKeyOf(rand(32)), passkey: bytesToHex(rand(16)), client: bytesToHex(rand(8)), token: sha256Hex(bytesToHex(rand(24))) };
  }, []);
  const [userId, setUserId] = useState("");
  useEffect(() => void userForSubject(claims.iss, claims.sub).then(setUserId), [claims.iss, claims.sub]);
  const signed = useMemo(() => {
    if (!userId) return null;
    const sk = deriveIssuerKey(keys.secret, userId);
    const iss = publicKeyOf(sk);
    const draft = { aud: "agent:claude", act: "github.pr.merge", res: [PR], when: [{ c: "checks.pass" }], nbf: NOW, exp: NOW + 900, uses: 1, risk: "medium" as const, from: { utterance: "I approve merging #7", request: null } };
    const grant = buildGrant(draft, iss, { method: "webauthn", at: NOW, proof: { credential: keys.passkey } }, bytesToHex(crypto.getRandomValues(new Uint8Array(12))));
    return { iss, grant, event: grantEvent(grant, sk) as NostrEvent };
  }, [userId, keys]);

  return (
    <main className="mx-auto max-w-5xl space-y-10 px-4 py-8 md:px-8">
      <section className="space-y-2">
        <h1 className="font-semibold text-3xl">Your company's sign-in, groups and OAuth</h1>
        <p className="max-w-3xl text-muted-foreground">
          People sign in with the identity provider they already use. Their groups set limits above their own rules, so an organization says what's possible and each person still okays things inside that. Agents connect over OAuth, and their token's scopes narrow it further. Everything below runs okayed's real code in your browser.
        </p>
      </section>

      <Step n="1" title="Someone signs in" hint="OpenID Connect: okayed checks the ID token's signature against the provider's published keys, then reads who they are.">
        <div className="grid items-start gap-4 md:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <SignInScreen providers={PROVIDERS} provider={provider} onProvider={setProvider}>
            <div className="mb-2 text-muted-foreground text-xs">Signing in as</div>
            <div className="flex flex-wrap gap-1.5">
              {PEOPLE.map((p) => (
                <button key={p.email} type="button" aria-pressed={p.email === who} onClick={() => setWho(p.email)} className="inline-flex items-center gap-1.5 rounded-full border bg-background py-1 pr-2.5 pl-1 text-sm aria-pressed:border-primary aria-pressed:bg-primary/8">
                  <AgentAvatar agent={p.name} className="size-5 text-[10px]" />{p.name.split(" ")[0]}{p.active ? "" : " (removed)"}
                </button>
              ))}
            </div>
          </SignInScreen>
          <div className="min-w-0 space-y-2">
            <Panel title={`${idp.name}'s ID token`}>
              <pre className="max-h-64 overflow-auto font-mono text-xs">{JSON.stringify(claims, null, 2)}</pre>
              <p className="mt-2 text-muted-foreground text-xs">{idp.note}</p>
            </Panel>
          </div>
        </div>
      </Step>

      <Step n="2" title="Who's who, and which key signs what" hint="Everything that acts for this person, and how each one proves itself. The keys are generated in your browser; the permission at the bottom is really signed and checked.">
        {signed && (
          <IdentityCard
            id={{
              provider: idp,
              name: person.name,
              email: person.email,
              principal: principal.id,
              userId,
              issuer: signed.iss,
              passkey: keys.passkey,
              approver: keys.approver,
              agentToken: keys.token,
              oauthClient: `mcp_${keys.client}`,
              scopes,
              workload: "repo:acme/web:ref:refs/heads/main",
              groups: [...principal.groups, ...principal.roles.map((r) => `role:${r}`)],
              limits: ceiling?.rules.length ?? 0,
              active: person.active,
              event: signed.event,
            }}
          />
        )}
      </Step>

      <Step n="3" title="Their organization sets limits" hint="An organization's policy by group. Set it as ORG_POLICY; groups come from the token, Cloudflare Access, or SCIM at /scim/v2.">
        <div className="grid gap-3 md:grid-cols-2">
          <Panel title="Acme's policy (edit it)">
            <Textarea value={policyText} onChange={(e) => setPolicyText(e.target.value)} rows={14} className="font-mono text-xs" aria-label="Organization policy" />
            {problems.length > 0 && <p className="mt-2 text-deny text-sm">The policy {problems.join("; ")}.</p>}
          </Panel>
          <Panel title={`What applies to ${person.name.split(" ")[0]}`}>
            {ceiling ? (
              <ul className="space-y-1.5 text-sm">
                {ceiling.rules.map((r) => (
                  <li key={r.id} className="flex items-center gap-2">
                    <ActionTile act={r.act} size="sm" className="size-6 [&_svg]:size-3.5" />
                    <span className={WORD_CLS[r.effect]}>{r.effect}</span> {PHRASE[r.act] ?? r.act}{r.res ? <span className="text-muted-foreground"> · {r.res}</span> : null}
                  </li>
                ))}
                <li className="text-muted-foreground">Anything else: {ceiling.default === "deny" ? "blocked" : "left to them"}.</li>
              </ul>
            ) : <p className="text-muted-foreground text-sm">Fix the policy to see it.</p>}
          </Panel>
        </div>
      </Step>

      <Step n="4" title="An agent connects over OAuth" hint="Remote MCP: the client registers (/register), the person allows it on okayed's consent screen (/authorize), and it gets a token (/token). Scopes on that token narrow what the agent may even ask for.">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-sm">Scopes on its token:</span>
          <ToggleGroup type="multiple" variant="outline" size="sm" value={scopes} onValueChange={setScopes} className="flex-wrap">
            {SCOPES.map((s) => <ToggleGroupItem key={s} value={s} className="font-mono text-xs">{s}</ToggleGroupItem>)}
          </ToggleGroup>
        </div>
      </Step>

      <Step n="5" title="What the agent may do" hint="The strictest layer wins: the organization, the token, then the person's own rules. Allowed means it goes ahead with a one-time, signed permission.">
        <div className="overflow-x-auto rounded-2xl border bg-card">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b">
                <th className="p-3 font-medium">Request</th>
                <th className="p-3 font-medium">Acme</th>
                <th className="p-3 font-medium">OAuth token</th>
                <th className="p-3 font-medium">Their rules</th>
                <th className="p-3 font-medium">Answer</th>
              </tr>
            </thead>
            <tbody>
              {QUESTIONS.map((q) => {
                const layers = [...(ceiling ? [ceiling] : []), tokenLayer, mine];
                const d = decideAll({ layers }, q.act, [q.res], NOW, { agent: AGENT });
                const by = (l: Layer) => d.layers.find((x) => x.layer === l.name)?.verdict;
                return (
                  <tr key={q.label} className="border-b last:border-0">
                    <td className="p-3"><span className="inline-flex items-center gap-2"><ActionTile act={q.act} size="sm" className="size-6 [&_svg]:size-3.5" />{q.label}</span></td>
                    <td className="p-3"><Verdict v={ceiling ? by(ceiling) : undefined} /></td>
                    <td className="p-3"><Verdict v={by(tokenLayer)} /></td>
                    <td className="p-3"><Verdict v={by(mine)} /></td>
                    <td className={`p-3 font-semibold ${WORD_CLS[d.verdict]}`}>{WORD[d.verdict]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-muted-foreground text-xs">An allowed merge still carries its rule's condition: the checks on {labelRes(PR)} must pass before it can be used.</p>
      </Step>

      <Step n="6" title="The permission, in OAuth's own terms" hint="A grant written as RFC 9396 authorization_details, so an authorization server can mint a token for exactly what was okayed, and agents can ask in the same format.">
        <Panel title="authorization_details">
          <pre className="overflow-auto font-mono text-xs">{signed ? JSON.stringify(detailsForGrant(signed.grant, { location: "https://api.github.com" }), null, 2) : ""}</pre>
        </Panel>
      </Step>

      <p className="text-center text-muted-foreground text-sm">
        Turn these on in a deployment with <code className="font-mono">OIDC_ISSUER</code> or <code className="font-mono">ACCESS_TEAM</code>, <code className="font-mono">ORG_POLICY</code> and <code className="font-mono">SCIM_TOKEN</code>. The live demo runs without them, as anonymous accounts.{" "}
        <a className="underline underline-offset-4" href="https://github.com/adrianmross/okayed/blob/main/docs/interop.md">Setup guide ↗</a>
      </p>
    </main>
  );
}

function Step({ n, title, hint, children }: { n: string; title: string; hint: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary text-sm">{n}</span>
        <div>
          <h2 className="font-semibold text-lg">{title}</h2>
          <p className="text-muted-foreground text-sm">{hint}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-2xl border bg-card p-4">
      <div className="mb-2 font-medium text-sm">{title}</div>
      {children}
    </div>
  );
}

function Verdict({ v }: { v: string | undefined }) {
  if (!v || v === "abstain") return <span className="text-muted-foreground">—</span>;
  return <span className={WORD_CLS[v as keyof typeof WORD_CLS]}>{v === "allow" ? "allows" : v === "ask" ? "asks" : "blocks"}</span>;
}
