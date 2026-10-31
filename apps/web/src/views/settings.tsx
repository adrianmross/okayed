import { ActionTile, AgentAvatar, ApprovalCard, KeyChip, agentName, type ApprovalFlow, type ApprovalLayout } from "@okayed/design/okayed";
import { ToggleGroup, ToggleGroupItem } from "@okayed/design/ui/toggle-group";
import { Button } from "@okayed/design/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@okayed/design/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@okayed/design/ui/dialog";
import { Input } from "@okayed/design/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@okayed/design/ui/item";
import { Spinner } from "@okayed/design/ui/spinner";
import { DEFAULT_POSTURE, type Rule } from "@okayed/engine";
import { ChevronRightIcon, CopyIcon, KeyRoundIcon, PlugIcon, RotateCcwIcon, ScanFaceIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Page, Section } from "../components/page";
import { useOkayed } from "../lib/okayed";
import { useApprovalStyle } from "../lib/style";
import { passkeyName, passkeysSupported, setUpPasskey } from "../lib/passkey";

const PRESETS: { name: string; text: string; rules: Rule[]; tone: "deploy" | "merge" | "read" }[] = [
  { name: "Balanced", text: "Reads, comments, merges with passing checks and staging deploys are allowed. Production and money ask you.", rules: DEFAULT_POSTURE, tone: "deploy" },
  {
    name: "Cautious",
    text: "Only reading is allowed. Everything else asks you.",
    rules: [
      { id: "cautious:read", effect: "allow", act: "github.read", note: "reading is allowed" },
      { id: "cautious:spend", effect: "ask", act: "spend.money", note: "spending asks" },
    ],
    tone: "merge",
  },
  { name: "Ask for everything", text: "No rules. Every action asks you.", rules: [], tone: "read" },
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
      toast.success(`${passkeyName()} is ready.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title="Settings" description="How you allow things, which rules you start from, and which agents can ask.">
      <div className="space-y-10">
        <Section title="Face ID" description="A passkey on this device signs each thing you allow. The signature covers exactly that request and travels with the permission, so anyone can check it later.">
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
              <p className="text-muted-foreground text-sm">This browser can't create passkeys, so allowing here is a plain tap.</p>
            )}
          </div>
        </Section>

        <ApprovalButtons />

        <Section title="Presets" description="Start over from a preset. It replaces your rules, and you can change any of them afterwards.">
          <div className="grid gap-3 md:grid-cols-3">
            {PRESETS.map((p) => (
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

        <Section title="Agents" description="Agents that can ask you for permission. The assistant is the one in Chat; connect your own over MCP." action={<div className="flex gap-2"><TrustWorkload /><ConnectAgent /></div>}>
          <div className="space-y-2">
            {[...new Set(["agent:assistant", ...snap.targets.agents, ...snap.agents.map((a) => a.id)])].map((id) => (
              <Item key={id} variant="outline" className="bg-card">
                <ItemMedia><AgentAvatar agent={id} /></ItemMedia>
                <ItemContent>
                  <ItemTitle>{agentName(id)}</ItemTitle>
                  <ItemDescription>{(() => {
                    const a = snap.agents.find((x) => x.id === id);
                    if (!a) return "The demo assistant in Chat";
                    const how = a.workload ? `Proves itself as ${a.workload.subject}, from ${new URL(a.workload.issuer).hostname}` : "Connected with a token";
                    return a.groups?.length ? `${how} · in ${a.groups.join(", ")}` : how;
                  })()}</ItemDescription>
                </ItemContent>
                {snap.agents.some((a) => a.id === id) && (
                  <ItemActions><Button size="sm" variant="ghost" onClick={() => okayed.run("DELETE", `/agents/${encodeURIComponent(id)}`, undefined, "Agent disconnected.")}>Disconnect</Button></ItemActions>
                )}
              </Item>
            ))}
          </div>
        </Section>

        {!okayed.session.access && (
          <Section title="Start over" description="To clear just the conversation, use Reset chat at the top of Chat.">
            <ResetDemo />
          </Section>
        )}

        <Section title="Account" description="This demo account is anonymous. A company would sign people in with its own identity provider, with limits from their groups.">
          <Item variant="outline" className="bg-card">
            <ItemMedia><ActionTile tone="policy" icon={<KeyRoundIcon />} size="sm" /></ItemMedia>
            <ItemContent>
              <ItemTitle>{okayed.session.access ? "Signed in with your organization" : "Anonymous demo account"}</ItemTitle>
              <ItemDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                Account <KeyChip value={snap.userId} /> Signing key <KeyChip value={snap.issuer} />
              </ItemDescription>
            </ItemContent>
          </Item>
          <a href="playground/#orgs" className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline">
            See how Okta, Entra, Google and OAuth plug in, and which key signs what<ChevronRightIcon className="size-4" />
          </a>
          <Collapsible className="group rounded-2xl border bg-card">
            <CollapsibleTrigger className="flex w-full items-center gap-2 p-4 text-left font-medium text-sm">
              Advanced
              <ChevronRightIcon className="ml-auto size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <dl className="grid gap-x-6 gap-y-2 px-4 pb-4 text-sm md:grid-cols-[max-content_1fr]">
                <dt className="text-muted-foreground">Server</dt>
                <dd className="break-all font-mono text-xs">{okayed.session.api}</dd>
                <dt className="text-muted-foreground">Reads your words with</dt>
                <dd>{snap.drafter}</dd>
              </dl>
            </CollapsibleContent>
          </Collapsible>
          <Button variant="ghost" className="text-muted-foreground" onClick={okayed.signOut}>Sign out on this device</Button>
        </Section>
      </div>
    </Page>
  );
}

/** Everything back to the start: a fresh demo account, after taking back what the old one's agents hold. */
function ResetDemo() {
  const okayed = useOkayed();
  const [busy, setBusy] = useState(false);
  const reset = async () => {
    setBusy(true);
    try {
      await okayed.reset();
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Item variant="outline" className="bg-card">
      <ItemContent>
        <ItemTitle>Reset demo</ItemTitle>
        <ItemDescription>Everything back to the start: chat, rules, permissions, history and passkeys.</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Dialog>
          <DialogTrigger asChild><Button variant="outline" size="sm" className="text-deny"><RotateCcwIcon />Reset</Button></DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Reset the demo?</DialogTitle>
              <DialogDescription>Every permission your agents hold is taken back, and you start again on a fresh demo account with the starting rules. You'll set up {passkeyName()} again.</DialogDescription>
            </DialogHeader>
            <Button variant="destructive" onClick={reset} disabled={busy}>{busy && <Spinner />}Reset everything</Button>
          </DialogContent>
        </Dialog>
      </ItemActions>
    </Item>
  );
}

/** How approval cards decide, on this device: the layout of the buttons, and tap, swipe or hold-and-slide. */
function ApprovalButtons() {
  const [style, setStyle] = useApprovalStyle();
  const [log, setLog] = useState("Try it: nothing here is sent anywhere.");
  const days = (t?: number | null) => (t === undefined ? "opens the editor" : t === null ? "with no end" : t >= 86400 ? `for ${t / 86400} day${t === 86400 ? "" : "s"}` : `for ${t / 3600} hour${t === 3600 ? "" : "s"}`);
  return (
    <Section
      title="Approvals"
      description="How cards ask you to decide on this device. Swipe: swipe right to allow. Hold Always, rest on how long, then slide up and swipe; hold Deny to swipe left, resting on how long to block requests like it."
    >
      <div className="grid gap-4 md:grid-cols-[1fr_minmax(0,28rem)]">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="font-medium text-sm">To decide</div>
            <ToggleGroup type="single" variant="outline" value={style.flow === "swipe" ? "swipe" : "tap"} onValueChange={(v) => v && setStyle({ ...style, flow: v as ApprovalFlow })}>
              <ToggleGroupItem value="swipe">Swipe</ToggleGroupItem>
              <ToggleGroupItem value="tap">Buttons</ToggleGroupItem>
            </ToggleGroup>
          </div>
          {style.flow !== "swipe" && (
            <div className="space-y-1.5">
              <div className="font-medium text-sm">Buttons</div>
              <ToggleGroup type="single" variant="outline" value={style.layout} onValueChange={(v) => v && setStyle({ ...style, layout: v as ApprovalLayout })}>
                <ToggleGroupItem value="stack">Stacked</ToggleGroupItem>
                <ToggleGroupItem value="row">In a row</ToggleGroupItem>
              </ToggleGroup>
            </div>
          )}
          <p className="text-muted-foreground text-sm" aria-live="polite">{log}</p>
        </div>
        <ApprovalCard
          agent="agent:assistant"
          act="site.deploy"
          res={["site:openmeadow.org/production"]}
          uses={1}
          ttl={1800}
          when={[]}
          risk="high"
          why="I want to ship the latest build to production."
          state="pending"
          passkey="ready"
          layout={style.layout}
          flow={style.flow}
          onApprove={() => setLog("Allowed once.")}
          onDeny={() => setLog("Denied.")}
          onAlwaysAllow={(t) => setLog(`Always allow: ${days(t)}.`)}
          onBlock={(t) => setLog(`Block: ${days(t)}.`)}
        />
      </div>
    </Section>
  );
}

const GITHUB_ACTIONS = "https://token.actions.githubusercontent.com";

/**
 * Trust a CI workflow (or any workload) to act as an agent by the identity token its platform gives it: nothing to
 * store in CI, and the token lives minutes.
 */
function TrustWorkload() {
  const okayed = useOkayed();
  const [open, setOpen] = useState(false);
  const [issuer, setIssuer] = useState(GITHUB_ACTIONS);
  const [subject, setSubject] = useState("");
  const [name, setName] = useState("");
  const audience = okayed.session.api;
  const save = async () => {
    if ((await okayed.run("POST", "/trusts", { issuer, subject, audience, name: name || undefined }, "Trusted. It can ask for permission now.")) !== undefined) setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="outline" size="sm"><ShieldCheckIcon />Trust a workflow</Button></DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Trust a workflow</DialogTitle>
          <DialogDescription>A CI job proves who it is with a short-lived token from its platform, so there's no secret to store. It becomes one of your agents and asks like any other.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), void save())}>
          <ToggleGroup type="single" variant="outline" size="sm" value={issuer === GITHUB_ACTIONS ? "gha" : "other"} onValueChange={(v) => v && setIssuer(v === "gha" ? GITHUB_ACTIONS : "https://")}>
            <ToggleGroupItem value="gha">GitHub Actions</ToggleGroupItem>
            <ToggleGroupItem value="other">Another OIDC issuer</ToggleGroupItem>
          </ToggleGroup>
          {issuer !== GITHUB_ACTIONS && <Input value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://issuer.example" aria-label="Issuer" />}
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={issuer === GITHUB_ACTIONS ? "repo:owner/name:ref:refs/heads/main" : "the token's subject (* for any run of characters)"} aria-label="Subject" className="font-mono text-xs" />
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Agent name, e.g. release workflow" aria-label="Agent name" />
          <p className="text-muted-foreground text-xs">
            In the workflow, ask for an ID token with the audience <span className="font-mono">{audience}</span> and send it as the bearer token.
            {issuer === GITHUB_ACTIONS && " It needs permissions: id-token: write."}
          </p>
          <Button type="submit" disabled={!subject.trim() || !/^https:\/\/\S+/.test(issuer)}>Trust it</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConnectAgent() {
  const okayed = useOkayed();
  const [name, setName] = useState("");
  const [minted, setMinted] = useState<{ id: string; token: string } | null>(null);
  const config = minted
    ? JSON.stringify({ mcpServers: { okayed: { command: "node", args: ["okayed/apps/mcp/src/main.ts"], env: { OKAYED_API: okayed.session.api, OKAYED_USER: okayed.session.userId, OKAYED_TOKEN: minted.token } } } }, null, 2)
    : "";
  const remote = `${okayed.session.api}/mcp`;
  return (
    <Dialog onOpenChange={(o) => !o && (setMinted(null), setName(""))}>
      <DialogTrigger asChild><Button variant="outline" size="sm"><PlugIcon />Connect an agent</Button></DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect an agent</DialogTitle>
          <DialogDescription>Any MCP client can connect by URL: it signs in through okayed, and you allow it here. Or mint a token for a local MCP server.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 rounded-xl border p-3">
          <p className="font-medium text-sm">Remote MCP server</p>
          <div className="flex gap-2">
            <Input readOnly value={remote} className="font-mono text-xs" aria-label="MCP server URL" />
            <Button variant="secondary" size="sm" onClick={() => navigator.clipboard.writeText(remote).then(() => toast.success("Copied."), () => toast.error("Couldn't copy; select the text instead."))}><CopyIcon />Copy</Button>
          </div>
          <p className="text-muted-foreground text-xs">Add it to Claude, Cursor or any MCP client. It opens okayed to ask you, then shows up under Agents.</p>
        </div>
        <p className="font-medium text-sm">Or a local MCP server, with a token</p>
        {!minted ? (
          <form className="flex gap-2" onSubmit={async (e) => (e.preventDefault(), setMinted((await okayed.run<{ id: string; token: string }>("POST", "/agents", { name })) ?? null))}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Agent name, e.g. ci-bot" aria-label="Agent name" />
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
