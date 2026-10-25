import type { Card, GrantRecord, RequestRecord, Snapshot } from "@okayed/core";
import { useAgent } from "agents/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { approveWithPasskey, passkeysSupported } from "./passkey";
import { call, type Session } from "./session";

interface Okayed {
  session: Session;
  snap: Snapshot | null;
  /** Calls the API; shows `ok` on success or the error; the snapshot arrives over the socket. */
  run: <T = unknown>(method: string, path: string, body?: unknown, ok?: string) => Promise<T | undefined>;
  call: <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;
  /** Approves a card: with a passkey where the browser has one, otherwise a plain okay. */
  approve: (cardId: string, plain?: boolean) => Promise<boolean>;
  deny: (cardId: string) => Promise<boolean>;
  requestByRef: (ref: string) => RequestRecord | undefined;
  card: (id?: string) => Card | undefined;
  grant: (id?: string) => (GrantRecord & { sentence: string }) | undefined;
  signOut: () => void;
}

const Ctx = createContext<Okayed | null>(null);

export function useOkayed(): Okayed {
  const v = useContext(Ctx);
  if (!v) throw new Error("useOkayed outside OkayedProvider");
  return v;
}

/** Keeps the person's snapshot live over the Agents SDK socket and offers the actions every view uses. */
export function OkayedProvider({ session, onSignOut, children }: { session: Session; onSignOut: () => void; children: ReactNode }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const url = new URL(session.api);
  useAgent<Snapshot | null>({
    agent: "okayed-agent",
    name: session.userId,
    host: url.host,
    protocol: url.protocol === "https:" ? "wss" : "ws",
    query: { token: session.ownerToken },
    onStateUpdate: (state: Snapshot | null) => state && setSnap(state),
  } as never);

  useEffect(() => {
    call<Snapshot>(session, "GET", "/state").then(setSnap, (e: Error) => toast.error(e.message));
  }, [session]);

  const callApi = useCallback(<T,>(method: string, path: string, body?: unknown) => call<T>(session, method, path, body), [session]);
  const run = useCallback(
    async <T,>(method: string, path: string, body?: unknown, ok?: string) => {
      try {
        const out = await call<T>(session, method, path, body);
        if (ok) toast.success(ok);
        return out;
      } catch (e) {
        toast.error((e as Error).message);
        return undefined;
      }
    },
    [session],
  );

  const value = useMemo<Okayed>(
    () => ({
      session,
      snap,
      run,
      call: callApi,
      approve: async (cardId, plain) => {
        try {
          if (!plain && passkeysSupported()) await approveWithPasskey(session, cardId);
          else await call(session, "POST", `/cards/${cardId}/confirm`, {});
          return true;
        } catch (e) {
          const msg = (e as Error).message;
          toast.error(/NotAllowed|cancel|timed out/i.test(msg) ? "Face ID was cancelled." : msg);
          return false;
        }
      },
      deny: async (cardId) => (await run(`POST`, `/cards/${cardId}/deny`)) !== undefined,
      requestByRef: (ref) => snap?.requests.find((r) => r.ref === ref),
      card: (id) => (id ? snap?.cards.find((c) => c.id === id) : undefined),
      grant: (id) => (id ? snap?.grants.find((g) => g.grant.id === id) : undefined),
      signOut: onSignOut,
    }),
    [session, snap, run, callApi, onSignOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
