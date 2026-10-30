import { useState } from "react";
import { ApprovalCard, type ApprovalState } from "../approval";

/** A purchase asks with a money card: the amount, what it's for, how it's paid, Swipe to pay, and Not now. */
export function ApprovalCardPay() {
  const [state, setState] = useState<ApprovalState>("pending");
  return (
    <ApprovalCard
      agent="agent:assistant"
      act="spend.money"
      res={["money:card-1/USD/12"]}
      uses={1}
      ttl={900}
      when={[]}
      risk="high"
      what="openmeadow.dev, for a year"
      method="Visa ···· 4242"
      state={state}
      passkey="ready"
      onApprove={() => setState("approved")}
      onDeny={() => setState("denied")}
    />
  );
}
