import { ActionTile, AgentAvatar, KeyChip, Seal } from "@okayed/design/okayed";
import { cn } from "@okayed/design/lib/utils";
import { verifyEvent, type NostrEvent } from "@okayed/grant";
import { BuildingIcon, CheckIcon, ChevronRightIcon, FileJson2Icon, KeyRoundIcon, ScanFaceIcon, SmartphoneIcon, WorkflowIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ProviderMark } from "./marks";

export interface Provider {
  id: string;
  name: string;
  /** Its mark in ./marks. */
  mark: string;
  iss: string;
}

/** The sign-in screen a company's okayed shows: its identity providers as buttons, and who's signing in. */
export function SignInScreen({ providers, provider, onProvider, children }: { providers: Provider[]; provider: string; onProvider: (id: string) => void; children?: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-md rounded-3xl border bg-card p-6 shadow-sm">
      <div className="mb-1 flex items-center gap-2 font-semibold text-lg">
        <img src="./favicon.svg" alt="" className="size-6" />okayed <span className="font-normal text-muted-foreground">· Acme</span>
      </div>
      <p className="mb-5 text-muted-foreground text-sm">Sign in with your company account.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {providers.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={p.id === provider}
            onClick={() => onProvider(p.id)}
            className="flex items-center gap-2.5 rounded-xl border bg-background px-3 py-2.5 text-left text-sm transition hover:border-primary/40 aria-pressed:border-primary aria-pressed:ring-2 aria-pressed:ring-primary/20"
          >
            <ProviderMark id={p.mark} className="size-5 shrink-0" />
            <span className="min-w-0 truncate">{p.name}</span>
          </button>
        ))}
      </div>
      {children && <div className="mt-5 border-t border-dashed pt-4">{children}</div>}
    </div>
  );
}

export interface Identity {
  provider: Provider;
  name: string;
  email: string;
  /** `oidc:<issuer>#<sub>`: who they are to every system. */
  principal: string;
  /** Their okayed: sha256 of issuer and subject. */
  userId: string;
  /** Their okayed's signing key: secp256k1, x-only, as in Nostr. */
  issuer: string;
  passkey: string;
  approver: string;
  agentToken: string;
  oauthClient: string;
  scopes: string[];
  workload: string;
  groups: string[];
  limits: number;
  active: boolean;
  /** A permission, signed by `issuer`. */
  event: NostrEvent | null;
}

/** Who someone is and every key that acts for them, laid out like a receipt: who vouches, who signs, and for what. */
export function IdentityCard({ id }: { id: Identity }) {
  const [open, setOpen] = useState(false);
  const valid = id.event ? verifyEvent(id.event) && id.event.pubkey === id.issuer : false;
  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      <div className="flex items-start gap-3 border-b border-dashed px-4 py-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted"><ProviderMark id={id.provider.mark} className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{id.name}</div>
          <div className="text-muted-foreground text-sm">{id.email} · signed in with {id.provider.name}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs"><span className="text-muted-foreground">Identity</span><KeyChip value={id.principal} head={22} tail={8} /></div>
        </div>
        {id.active ? <Seal className="size-11 [&_svg]:size-9" label="Signed in" /> : <span className="rounded-full bg-deny/12 px-2 py-0.5 font-medium text-deny text-xs">Removed</span>}
      </div>

      <Group title="Their okayed">
        <Row icon={<ActionTile tone="policy" icon={<KeyRoundIcon />} size="sm" />} title="Signing key" what="Signs every permission, take-back and receipt. A secp256k1 Schnorr key, as in Nostr, so anyone can check a signature without asking okayed." value={id.issuer} />
        <Row icon={<ActionTile tone="any" icon={<span className="font-mono text-[10px]">id</span>} size="sm" />} title="Account" what={`From ${id.provider.name}'s issuer and subject, so the same person always lands on the same okayed.`} value={id.userId} />
      </Group>

      <Group title="Where they say yes">
        <Row icon={<ActionTile tone="policy" icon={<ScanFaceIcon />} size="sm" />} title="Face ID on this Mac" what="A passkey (P-256). It signs each approval, bound to that exact request, and the signature travels with the permission." value={id.passkey} />
        <Row icon={<ActionTile tone="deploy" icon={<SmartphoneIcon />} size="sm" />} title="Approver app on their phone" what="Its own Nostr key. It answers with a signed approval (kind 4845); okayed trusts that signature, not the network." value={id.approver} />
      </Group>

      <Group title="Agents that act for them">
        <Row icon={<AgentAvatar agent="agent:assistant" />} title="Assistant" what="An agent token, stored only as its hash." value={id.agentToken} />
        <Row icon={<AgentAvatar agent="agent:claude" />} title="Claude, over MCP" what={`An OAuth client they allowed on okayed's consent screen. Its token carries ${id.scopes.length ? id.scopes.join(", ") : "no scopes"}.`} value={id.oauthClient} />
        <Row icon={<ActionTile tone="merge" icon={<WorkflowIcon />} size="sm" />} title="Release workflow" what="GitHub Actions proves which workflow it is with a short-lived OIDC token, so CI holds no secret." value={id.workload} />
      </Group>

      <Group title="Their organization">
        <Row
          icon={<ActionTile tone="any" icon={<BuildingIcon />} size="sm" />}
          title="Acme"
          what={id.active ? `${id.groups.length ? `In ${id.groups.join(", ")}` : "No groups in the token"}: ${id.limits} limits above their own rules.` : "The directory removed them: every permission their agents hold is taken back, and nothing new can be issued."}
        />
      </Group>

      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2.5 text-xs">
        <span className={cn("inline-flex items-center gap-1", valid ? "text-allow" : "text-muted-foreground")}><CheckIcon className="size-3.5" />{valid ? "A permission signed by this key checks out" : "Signing…"}</span>
        <button type="button" onClick={() => setOpen(!open)} className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <FileJson2Icon className="size-3.5" />Signed record<ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
      </div>
      {open && id.event && <pre className="max-h-80 overflow-auto border-t bg-muted/40 p-4 font-mono text-[11px]">{JSON.stringify({ ...id.event, content: JSON.parse(id.event.content) }, null, 2)}</pre>}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-b border-dashed px-4 py-3 last:border-0">
      <div className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">{title}</div>
      <div className="divide-y divide-border/60">{children}</div>
    </div>
  );
}

function Row({ icon, title, what, value }: { icon: ReactNode; title: string; what: string; value?: string }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-sm">{title}</span>
          {value && <KeyChip value={value} />}
        </div>
        <p className="text-muted-foreground text-xs leading-relaxed">{what}</p>
      </div>
    </div>
  );
}
