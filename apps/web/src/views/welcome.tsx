import { ActionTile, Seal } from "@okayed/design/okayed";
import { Button } from "@okayed/design/ui/button";
import { Input } from "@okayed/design/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@okayed/design/ui/collapsible";
import { Spinner } from "@okayed/design/ui/spinner";
import { useState } from "react";
import { toast } from "sonner";
import { Logo } from "../components/logo";
import { createUser, type Session } from "../lib/session";

const DEFAULT_API = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8787";

/** First visit: what okayed is, in three lines, and one button. */
export function Welcome({ onSession }: { onSession: (s: Session) => void }) {
  const [busy, setBusy] = useState(false);
  const [api, setApi] = useState(DEFAULT_API);
  const [user, setUser] = useState("");
  const [token, setToken] = useState("");
  const start = async () => {
    setBusy(true);
    try {
      onSession(await createUser(api.replace(/\/$/, "")));
    } catch (e) {
      toast.error(`Couldn't reach ${api}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-8 px-5 py-12">
      <div className="flex items-center gap-2 font-semibold text-xl"><Logo className="size-8" />okayed</div>
      <div className="space-y-3">
        <h1 className="font-semibold text-4xl leading-[1.1] md:text-5xl">Your okay,<br />made exact.</h1>
        <p className="text-lg text-muted-foreground">
          Chat with an assistant that can merge, deploy and buy things. Whenever it needs permission, okayed shows you exactly what it would do, and you allow it with Face ID. Your rules handle the rest.
        </p>
      </div>
      <ul className="space-y-3">
        {[
          ["merge", "Ask for anything. The assistant's tool calls show up right in the chat."],
          ["policy", "Allow one exact thing: this PR, this commit, once, for fifteen minutes."],
          ["deploy", "Or set a rule, the way you'd build a Shortcut, and let it handle the rest."],
        ].map(([tone, text]) => (
          <li key={tone} className="flex items-center gap-3">
            <ActionTile tone={tone as "merge"} act={tone === "merge" ? "github.pr.merge" : tone === "deploy" ? "site.deploy" : undefined} size="sm" />
            <span>{text}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-4">
        <Button size="lg" className="h-12 rounded-xl px-6 text-base" onClick={start} disabled={busy}>
          {busy && <Spinner />}Start the demo
        </Button>
        <Seal className="size-12 [&_svg]:size-10" label="okayed seal" />
      </div>
      <Collapsible className="text-sm">
        <CollapsibleTrigger className="text-muted-foreground underline-offset-4 hover:underline">Use an existing account or another server</CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-2">
          <Input value={api} onChange={(e) => setApi(e.target.value)} aria-label="Server" />
          <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="User id" aria-label="User id" />
          <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Owner token (own_…)" aria-label="Owner token" />
          <Button variant="secondary" disabled={!user || !token} onClick={() => onSession({ api: api.replace(/\/$/, ""), userId: user.trim(), ownerToken: token.trim() })}>Use this account</Button>
        </CollapsibleContent>
      </Collapsible>
    </main>
  );
}
