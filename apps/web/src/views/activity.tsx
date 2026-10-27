import type { Card, GrantRecord } from "@okayed/core";
import { ApprovalCard, ReceiptCard, type ApprovalState } from "@okayed/design/okayed";
import { Button } from "@okayed/design/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@okayed/design/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@okayed/design/ui/empty";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@okayed/design/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@okayed/design/ui/tabs";
import { CATALOG, labelRes } from "@okayed/engine";
import { OctagonXIcon } from "lucide-react";
import { useState } from "react";
import { useRuleFromCard } from "../components/always-allow";
import { useApprovalStyle } from "../lib/style";
import { Page } from "../components/page";
import { useOkayed } from "../lib/okayed";
import { passkeysSupported } from "../lib/passkey";

const PAST: Record<string, string> = { read: "Read", "comment on": "Comment on", merge: "Merge", deploy: "Deploy", spend: "Spend" };

/** "Merge PR #182 in adrianmross/okayed": the permission's action on its targets, without the commit. */
export function grantTitle(g: GrantRecord): string {
  const verb = CATALOG[g.grant.act]?.verb ?? g.grant.act;
  return `${PAST[verb] ?? verb} ${g.grant.res.map((r) => labelRes(r).replace(/ at [0-9a-f]{7}$/, "")).join(" and ")}`;
}

export function grantVia(g: GrantRecord): string {
  const a = g.grant.assurance;
  return a.method === "webauthn" ? "with Face ID" : a.method === "policy" ? "by your rules" : "by you";
}

function stateOf(c: Card): ApprovalState {
  return c.status === "confirming" ? "approving" : c.status === "confirmed" ? "approved" : c.status === "denied" ? "denied" : c.status === "open" ? "pending" : "expired";
}

function day(t: number): string {
  const d = new Date(t * 1000);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? "Today" : d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

export function ActivityView() {
  const okayed = useOkayed();
  const snap = okayed.snap;
  const [event, setEvent] = useState<GrantRecord | null>(null);
  const { alwaysAllow, block, editor } = useRuleFromCard();
  const [style] = useApprovalStyle();
  if (!snap) return <Page title="Activity">{null}</Page>;
  const waiting = snap.cards.filter((c) => c.status === "open" && c.kind === "grant" && c.draft);
  const active = snap.grants.filter((g) => g.status === "active");
  const byDay = new Map<string, typeof snap.grants>();
  for (const g of snap.grants.filter((x) => x.status !== "active")) byDay.set(day(g.grant.nbf), [...(byDay.get(day(g.grant.nbf)) ?? []), g]);
  const receipt = (g: GrantRecord) => (
    <ReceiptCard
      key={g.grant.id}
      act={g.grant.act}
      title={grantTitle(g)}
      agent={g.grant.aud}
      how={grantVia(g)}
      at={g.grant.nbf}
      grantId={g.grant.id}
      used={g.used}
      uses={g.grant.uses}
      status={g.status}
      onShowEvent={() => setEvent(g)}
      onRevoke={() => okayed.run("POST", `/grants/${g.grant.id}/revoke`, { reason: "taken back by you" }, "Taken back.")}
    />
  );

  return (
    <Page
      title="Activity"
      description="What's waiting for you, what your agents can do right now, and everything that happened."
      actions={<StopEverything paused={snap.paused} />}
    >
      <Tabs defaultValue={waiting.length ? "waiting" : active.length ? "permissions" : "history"}>
        <TabsList>
          <TabsTrigger value="waiting">Waiting{waiting.length ? ` · ${waiting.length}` : ""}</TabsTrigger>
          <TabsTrigger value="permissions">Permissions{active.length ? ` · ${active.length}` : ""}</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="waiting" className="mt-4">
          {waiting.length === 0 ? (
            <Empty className="border"><EmptyHeader><EmptyTitle>Nothing is waiting for you</EmptyTitle><EmptyDescription>When an agent asks for something your rules don't cover, it shows up here and in the chat.</EmptyDescription></EmptyHeader></Empty>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {waiting.map((c) => (
                <ApprovalCard
                  key={c.id}
                  agent={c.draft!.aud}
                  act={c.draft!.act}
                  res={c.draft!.res}
                  uses={c.draft!.uses}
                  ttl={c.ttl ?? c.draft!.exp - c.draft!.nbf}
                  when={c.draft!.when}
                  risk={c.draft!.risk}
                  why={snap.requests.find((r) => r.request.id === c.requestId)?.request.why}
                  cuts={c.beyond}
                  state={stateOf(c)}
                  passkey={passkeysSupported() ? (snap.passkeys.length ? "ready" : "setup") : "unsupported"}
                  onApprove={() => okayed.approve(c.id)}
                  onApprovePlain={() => okayed.approve(c.id, true)}
                  onAlwaysAllow={(t) => alwaysAllow(c, t)}
                  onBlock={(t) => block(c, t)}
                  layout={style.layout}
                  flow={style.flow}
                  onDeny={() => okayed.deny(c.id)}
                />
              ))}
            </div>
          )}
        </TabsContent>
        <TabsContent value="permissions" className="mt-4 space-y-2">
          {active.length === 0 ? (
            <Empty className="border"><EmptyHeader><EmptyTitle>No active permissions</EmptyTitle><EmptyDescription>When you or a rule allows something, the agent gets a one-time permission. It stays here until it's used, expires or you take it back.</EmptyDescription></EmptyHeader></Empty>
          ) : (
            active.map(receipt)
          )}
        </TabsContent>
        <TabsContent value="history" className="mt-4 space-y-6">
          {byDay.size === 0 && <Empty className="border"><EmptyHeader><EmptyTitle>Nothing yet</EmptyTitle><EmptyDescription>Every permission, whether you or a rule allowed it, leaves a signed receipt here once it's used or expires.</EmptyDescription></EmptyHeader></Empty>}
          {[...byDay].map(([d, gs]) => (
            <section key={d} className="space-y-2">
              <h2 className="font-medium text-muted-foreground text-sm">{d}</h2>
              {gs.map(receipt)}
            </section>
          ))}
          {snap.audit.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer font-medium text-muted-foreground text-sm">Everything that happened · {snap.audit.length}</summary>
              <ol className="mt-2 divide-y rounded-2xl border bg-card">
                {snap.audit.map((a, i) => (
                  <li key={i} className="flex gap-3 px-4 py-3 text-sm">
                    <span className="w-16 shrink-0 text-muted-foreground tabular">{new Date(a.at * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                    <span className="w-20 shrink-0 font-medium text-muted-foreground capitalize">{a.type}</span>
                    <span className="min-w-0 flex-1">{a.text}</span>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </TabsContent>
      </Tabs>

      <Sheet open={!!event} onOpenChange={(o) => !o && setEvent(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Signed permission</SheetTitle>
            <SheetDescription>okayed signs every permission as a grant: a Nostr event (kind 4841) that expires on its own (NIP-40). Anyone can check the signature; only okayed can spend its uses.</SheetDescription>
          </SheetHeader>
          {event && (
            <div className="space-y-3 px-4 pb-6">
              <pre className="overflow-x-auto rounded-xl bg-muted/60 p-3 font-mono text-xs leading-relaxed">{JSON.stringify(event.grant, null, 2)}</pre>
              <details>
                <summary className="cursor-pointer text-muted-foreground text-sm">The raw event</summary>
                <pre className="mt-2 overflow-x-auto rounded-xl bg-muted/60 p-3 font-mono text-xs">{JSON.stringify(event.event, null, 2)}</pre>
              </details>
            </div>
          )}
        </SheetContent>
      </Sheet>
      {editor}
    </Page>
  );
}

function StopEverything({ paused }: { paused: boolean }) {
  const okayed = useOkayed();
  if (paused) return <Button variant="secondary" onClick={() => okayed.run("POST", "/resume", undefined, "Rules resumed.")}>Resume rules</Button>;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" className="text-deny"><OctagonXIcon />Stop everything</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Stop everything?</DialogTitle>
          <DialogDescription>Every active permission is taken back at once, and your rules stop allowing things on their own until you resume. Agents will have to ask you for everything.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
          <DialogClose asChild><Button variant="destructive" onClick={() => okayed.run("POST", "/stop", { reason: "emergency stop" }, "Stopped. Every permission was taken back.")}>Stop everything</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
