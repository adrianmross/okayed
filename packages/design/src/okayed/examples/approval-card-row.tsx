import { useState } from "react";
import { ApprovalCard, type ApprovalState } from "../approval";

const PR = "github:adrianmross/okayed/pull/182@3f9a1c2e4b5d6f708192a3b4c5d6e7f801234567";

/** Every decision in one row: Don't allow · Always allow… · Allow once. Tap to decide. */
export function ApprovalCardRow() {
  const [state, setState] = useState<ApprovalState>("pending");
  return (
    <ApprovalCard
      flow="tap"
      layout="row"
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
      onAlwaysAllow={() => {
        // Open your rule editor here, prefilled from this request.
      }}
    />
  );
}
