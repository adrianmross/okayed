import { ActionTile, SwipeDecide } from "@okayed/design/okayed";
import { PlugIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Logo } from "../components/logo";
import type { Session } from "../lib/session";

/**
 * The OAuth consent for a remote MCP client, after /authorize sent the person here. Allowing makes the client a new
 * agent of theirs: it can ask for permission, never grant it, and it can be disconnected in Settings.
 */
export function Connect({ session }: { session: Session }) {
  const p = new URLSearchParams(location.hash.replace(/^#connect\??/, ""));
  const client = p.get("client") || "An app";
  const back = p.get("to");
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);

  const decide = async (allow: boolean) => {
    setBusy(allow ? "allow" : "deny");
    try {
      const r = await fetch(`${session.api}/authorize/${allow ? "approve" : "deny"}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(session.ownerToken ? { authorization: `Bearer ${session.ownerToken}` } : {}) },
        body: JSON.stringify({ h: p.get("h"), user: session.userId }),
      });
      const j = (await r.json().catch(() => ({}))) as { redirectTo?: string; error?: string };
      if (!r.ok || !j.redirectTo) throw new Error(j.error ?? "This request has expired. Start again from the app.");
      location.href = j.redirectTo;
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-6 px-5 py-12">
      <div className="flex items-center gap-2 font-semibold text-xl"><Logo className="size-8" />okayed</div>
      <div className="animate-rise space-y-5 rounded-[26px] border bg-card p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <ActionTile tone="policy" icon={<PlugIcon />} size="lg" />
          <h1 className="font-semibold text-xl leading-snug"><span className="text-primary">{client}</span> wants to connect to your okayed</h1>
        </div>
        <ul className="space-y-1.5 text-muted-foreground text-sm">
          <li>It becomes one of your agents: it can ask you for permission before it acts.</li>
          <li>It can't allow anything itself, and it never sees a credential.</li>
          <li>Disconnect it any time in Settings.</li>
        </ul>
        <SwipeDecide title={busy === "allow" ? "Connecting…" : busy === "deny" ? "Saying no…" : "Swipe to connect"} label={`Connect ${client}`} disabled={!!busy} onAllow={() => decide(true)} back={{ word: "Not now", onBack: () => decide(false) }} />
        {back && <p className="text-center text-muted-foreground text-xs">Then you'll go back to {back}.</p>}
      </div>
    </main>
  );
}
