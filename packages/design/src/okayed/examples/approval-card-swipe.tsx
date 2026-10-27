import { useState } from "react";
import { ApprovalCard, type ApprovalState } from "../approval";

/** The main decision is a slide: drag the knob across to allow, so a stray tap can't okay a production deploy. */
export function ApprovalCardSwipe() {
  const [state, setState] = useState<ApprovalState>("pending");
  return (
    <ApprovalCard
      flow="swipe"
      agent="agent:assistant"
      act="site.deploy"
      res={["site:openmeadow.org/production"]}
      uses={1}
      ttl={1800}
      when={[]}
      risk="high"
      why="ship the latest build to production"
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
