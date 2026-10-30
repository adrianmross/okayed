import type { ApprovalFlow, ApprovalLayout } from "@okayed/design/okayed";
import { useEffect, useState } from "react";

/** How approval cards lay out their buttons and how a decision is made, on this device. */
export interface ApprovalStyle {
  layout: ApprovalLayout;
  flow: ApprovalFlow;
}

const KEY = "okayed.approvalStyle.v1";
const DEFAULT: ApprovalStyle = { layout: "stack", flow: "swipe" };
const listeners = new Set<(s: ApprovalStyle) => void>();

function read(): ApprovalStyle {
  try {
    const s = { ...DEFAULT, ...(JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ApprovalStyle> | null) };
    // Holding to choose how long is part of swiping now.
    return s.flow === "hold" ? { ...s, flow: "swipe" } : s;
  } catch {
    return DEFAULT;
  }
}

export function useApprovalStyle(): [ApprovalStyle, (s: ApprovalStyle) => void] {
  const [style, setStyle] = useState(read);
  useEffect(() => {
    listeners.add(setStyle);
    return () => void listeners.delete(setStyle);
  }, []);
  const set = (s: ApprovalStyle) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      // storage blocked: the choice lasts as long as the tab
    }
    for (const l of listeners) l(s);
  };
  return [style, set];
}
