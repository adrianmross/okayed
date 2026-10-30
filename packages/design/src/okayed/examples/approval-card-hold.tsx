import { useState } from "react";
import { ApprovalCard, type ApprovalState } from "../approval";
import { HOLD_DURATIONS } from "../hold-slide";

const PR = "github:adrianmross/okayed/pull/182@3f9a1c2e4b5d6f708192a3b4c5d6e7f801234567";

const lasting = (s: number | null) => (s === null ? "with no end" : `for ${HOLD_DURATIONS.find((d) => d.seconds === s)?.label ?? `${s} seconds`}`);

/**
 * Hold "Always allow…" or "Block…", slide up to pick how long the rule lasts, then slide across to make it. A tap
 * still opens the editor; Allow once and Don't allow stay taps.
 */
export function ApprovalCardHold() {
  const [state, setState] = useState<ApprovalState>("pending");
  const [rule, setRule] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <ApprovalCard
        flow="hold"
        layout="stack"
        agent="agent:assistant"
        act="github.pr.merge"
        res={[PR]}
        uses={1}
        ttl={900}
        when={[{ c: "checks.pass" }]}
        risk="high"
        why="reviewed; CI green"
        state={state}
        passkey="ready"
        onApprove={() => setState("approved")}
        onDeny={() => setState("denied")}
        onAlwaysAllow={(s) => (s === undefined ? setRule("Open the rule editor") : (setRule(`Allow merges like this ${lasting(s)}`), setState("approved")))}
        onBlock={(s) => (s === undefined ? setRule("Open the rule editor, set to block") : (setRule(`Block merges like this ${lasting(s)}`), setState("denied")))}
      />
      {rule && <p className="text-muted-foreground text-sm">{rule}</p>}
    </div>
  );
}
