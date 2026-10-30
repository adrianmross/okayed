import { useState } from "react";
import { ApprovalCard, type ApprovalState } from "../approval";

const lasting = (s: number | null) => (s === null ? "until you remove it" : s >= 30 * 86400 ? "for 30 days" : "for a day");

/**
 * Swipe to allow. Hold Always, rest on how long (1d, 30d, ∞), then slide up into the track and swipe to make a rule
 * that long; hold Deny, rest on how long, and swipe left to block requests like this. Tapping either is never an
 * answer: Always shows its choices, Deny arms a left swipe.
 */
export function ApprovalCardSwipe() {
  const [state, setState] = useState<ApprovalState>("pending");
  const [rule, setRule] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <ApprovalCard
        agent="agent:assistant"
        act="site.deploy"
        res={["site:openmeadow.org/production"]}
        uses={1}
        ttl={1800}
        when={[]}
        risk="high"
        why="I want to ship the latest build to production."
        state={state}
        passkey="ready"
        onApprove={() => setState("approved")}
        onDeny={() => setState("denied")}
        onAlwaysAllow={(s) => (s === undefined ? setRule("Open your rule editor here, prefilled from this request.") : (setRule(`Allow deploys like this ${lasting(s)}`), setState("approved")))}
        onBlock={(s) => (setRule(`Block deploys like this ${lasting(s ?? null)}`), setState("denied"))}
      />
      {rule && <p className="text-muted-foreground text-sm">{rule}</p>}
    </div>
  );
}
