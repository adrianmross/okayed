import { ActionTile, AgentAvatar } from "@okayed/design/okayed";
import { Button } from "@okayed/design/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@okayed/design/ui/dialog";
import { Input } from "@okayed/design/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@okayed/design/ui/item";
import { Spinner } from "@okayed/design/ui/spinner";
import { DEFAULT_POSTURE, type Rule } from "@okayed/engine";
import { CopyIcon, KeyRoundIcon, PlugIcon, ScanFaceIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Page, Section } from "../components/page";
import { useOkayed } from "../lib/okayed";
import { passkeyName, passkeysSupported, setUpPasskey } from "../lib/passkey";

const POSTURES: { name: string; text: string; rules: Rule[]; tone: "deploy" | "merge" | "read" }[] = [
  { name: "Balanced", text: "Reads, comments, checked merges and staging deploys go ahead. Production and money ask.", rules: DEFAULT_POSTURE, tone: "deploy" },
  {
    name: "Cautious",
    text: "Only reading goes ahead. Everything else asks you.",
    rules: [
      { id: "cautious:read", effect: "allow", act: "github.read", note: "reading goes ahead" },
      { id: "cautious:spend", effect: "ask", act: "spend.money", note: "spending asks" },
    ],
    tone: "merge",
  },
  { name: "Ask for everything", text: "No policies. Every action asks you.", rules: [], tone: "read" },
];

export function SettingsView() {
  const okayed = useOkayed();
  const snap = okayed.snap;
  const [busy, setBusy] = useState(false);
  if (!snap) return <Page title="Settings">{null}</Page>;
  const setUp = async () => {
    setBusy(true);
    try {
      await setUpPasskey(okayed.session);
      toast.success(`${passkeyName()} is ready for approvals.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title="Settings" description="How you approve, where you start from, and which agents can ask.">
      <div className="space-y-10">
        <Section title="Approving with Face ID" description="A passkey on this device signs each approval. The signature is bound to exactly what you approved and travels with the grant.">
          <div className="space-y-2">
            {snap.passkeys.map((p) => (
              <Item key={p.id} variant="outline" className="bg-card">
                <ItemMedia><ActionTile tone="policy" icon={<ScanFaceIcon />} size="sm" /></ItemMedia>
                <ItemContent>
                  <ItemTitle>{p.name}</ItemTitle>
                  <ItemDescription>For {p.rpID} · added {new Date(p.createdAt * 1000).toLocaleDateString()}</ItemDescription>
                </ItemContent>
                <ItemActions><Button size="icon-sm" variant="ghost" aria-label="Remove passkey" onClick={() => okayed.run("DELETE", `/passkeys/${p.id}`, undefined, "Passkey removed.")}><Trash2Icon /></Button></ItemActions>
              </Item>
            ))}
            {passkeysSupported() ? (
              <Button variant={snap.passkeys.length ? "outline" : "default"} onClick={setUp} disabled={busy}>{busy ? <Spinner /> : <ScanFaceIcon />}{snap.passkeys.length ? "Add another passkey" : `Set up ${passkeyName()}`}</Button>
            ) : (
              <p className="text-muted-foreground text-sm">This browser can't create passkeys, so approvals here are a plain tap.</p>
            )}
          </div>
        </Section>

        <Section title="Starting posture" description="Replace your policies with a preset. You can change any of them afterwards.">
          <div className="grid gap-3 md:grid-cols-3">
            {POSTURES.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => okayed.run("PUT", "/policy", { rules: p.rules }, `Switched to ${p.name.toLowerCase()}.`)}
                className="flex flex-col items-start gap-2 rounded-2xl border bg-card p-4 text-left transition hover:border-primary/40 hover:shadow-sm"
              >
                <ActionTile tone={p.tone} icon={<KeyRoundIcon />} size="sm" />
                <span className="font-semibold">{p.name}</span>
                <span className="text-muted-foreground text-sm">{p.text}</span>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Agents" description="Agents that may ask okayed for permission. Assistant is the demo's assistant; connect your own over MCP." action={<ConnectAgent />}>
          <div className="space-y-2">
            {[...new Set(["agent:assistant", ...snap.targets.agents, ...snap.agents.map((a) => a.id)])].map((id) => (
              <Item key={id} variant="outline" className="bg-card">
                <ItemMedia><AgentAvatar agent={id} /></ItemMedia>
                <ItemContent>
                  <ItemTitle>{id.replace(/^agent:/, "")}</ItemTitle>
                  <ItemDescription>{snap.agents.some((a) => a.id === id) ? "Connected with a token" : "The demo assistant in Chat"}</ItemDescription>
                </ItemContent>
                {snap.agents.some((a) => a.id === id) && (
                  <ItemActions><Button size="sm" variant="ghost" onClick={() => okayed.run("DELETE", `/agents/${encodeURIComponent(id)}`, undefined, "Agent disconnected.")}>Disconnect</Button></ItemActions>
                )}
              </Item>
            ))}
          </div>
        </Section>

        <Section title="Account">
          <dl className="grid gap-x-6 gap-y-2 rounded-2xl border bg-card p-4 text-sm md:grid-cols-[max-content_1fr]">
            <dt className="text-muted-foreground">User</dt>
            <dd className="break-all font-mono text-xs">{snap.userId}</dd>
            <dt className="text-muted-foreground">Issuer key</dt>
            <dd className="break-all font-mono text-xs">{snap.issuer}</dd>
            <dt className="text-muted-foreground">Server</dt>
            <dd className="break-all font-mono text-xs">{okayed.session.api}</dd>
            <dt className="text-muted-foreground">Drafting</dt>
            <dd>{snap.drafter}</dd>
          </dl>
          <Button variant="ghost" className="text-muted-foreground" onClick={okayed.signOut}>Sign out on this device</Button>
        </Section>
      </div>
    </Page>
  );
}

function ConnectAgent() {
  const okayed = useOkayed();
  const [name, setName] = useState("");
  const [minted, setMinted] = useState<{ id: string; token: string } | null>(null);
  const config = minted
    ? JSON.stringify({ mcpServers: { okayed: { command: "node", args: ["okayed/apps/mcp/src/main.ts"], env: { OKAYED_API: okayed.session.api, OKAYED_USER: okayed.session.userId, OKAYED_TOKEN: minted.token } } } }, null, 2)
    : "";
  return (
    <Dialog onOpenChange={(o) => !o && (setMinted(null), setName(""))}>
      <DialogTrigger asChild><Button variant="outline" size="sm"><PlugIcon />Connect an agent</Button></DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect an agent</DialogTitle>
          <DialogDescription>It gets a token to ask okayed for permission. The token is shown once; okayed keeps only its hash.</DialogDescription>
        </DialogHeader>
        {!minted ? (
          <form className="flex gap-2" onSubmit={async (e) => (e.preventDefault(), setMinted((await okayed.run<{ id: string; token: string }>("POST", "/agents", { name })) ?? null))}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Agent name, e.g. buzz" aria-label="Agent name" />
            <Button type="submit" disabled={!name.trim()}>Connect</Button>
          </form>
        ) : (
          <div className="space-y-2">
            <p className="text-sm">Add this to your agent's MCP settings:</p>
            <pre className="max-h-64 overflow-auto rounded-xl bg-muted/60 p-3 font-mono text-xs">{config}</pre>
            <Button variant="secondary" size="sm" onClick={() => navigator.clipboard.writeText(config).then(() => toast.success("Copied."), () => toast.error("Couldn't copy; select the text instead."))}><CopyIcon />Copy</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
