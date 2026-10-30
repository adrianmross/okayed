import { ChevronDownIcon, ChevronRightIcon, CreditCardIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { DoneMark } from "./decided";
import { SwipeDecide } from "./swipe-decide";

export type MoneyState = "open" | "paying" | "paid" | "declined" | "expired";

export interface MoneyCardProps {
  /** Its first line: "Assistant asks to pay", with a mark. */
  head: ReactNode;
  /** "$12.00" */
  amount: string;
  /** What it's for: "openmeadow.dev, for a year". */
  what: ReactNode;
  /** How it would be paid: "Demo card ···· 4242". */
  method?: string;
  /** Change how it's paid. */
  onMethod?: () => void;
  state: MoneyState;
  /** Under the amount when decided: "Not charged: payments are simulated". */
  note?: string;
  onPay?: () => void;
  onDecline?: () => void;
  className?: string;
}

/**
 * Money, after a wallet card: who asks and for what, the amount big, how it would be paid, then "Swipe to pay" with
 * Not now at the end of the row. Decided, it folds to a small receipt, which a tap opens again. A light sweeps across
 * it once as it arrives. Its face is a deep green in both themes, as a card in a wallet is.
 */
export function MoneyCard({ head, amount, what, method, onMethod, state, note, onPay, onDecline, className }: MoneyCardProps) {
  const [unfold, setUnfold] = useState(false);
  const decided = state === "paid" || state === "declined" || state === "expired";
  const face = "relative w-full max-w-sm overflow-hidden rounded-[22px] bg-[linear-gradient(135deg,#21452F,#0E1D14)] text-white shadow-md";
  if (decided && !unfold) {
    return (
      <button type="button" onClick={() => setUnfold(true)} className={cn(face, "flex items-center gap-3 px-4 py-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", className)}>
        <DoneMark ok={state === "paid"} className="bg-white text-[#21452F]" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{state === "paid" ? "Approved" : state === "declined" ? "Declined" : "Expired"} {amount}</span>
          <span className="block truncate text-sm text-white/70">{note ?? what}</span>
        </span>
        <ChevronRightIcon className="size-4 text-white/70" />
      </button>
    );
  }
  return (
    <div className={cn(face, "motion-safe:animate-rise", className)}>
      <span aria-hidden="true" className="okayed-sheen pointer-events-none absolute -inset-y-10 w-16 rotate-[18deg] bg-white/13" />
      <div className="relative flex flex-col gap-2 p-5">
        <div className="flex items-center gap-2 text-sm text-white/72">
          <div className="min-w-0 flex-1">{head}</div>
          {decided ? (
            <button type="button" onClick={() => setUnfold(false)} aria-label="Fold the card" className="rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-white/60">
              <ChevronDownIcon className="size-4" />
            </button>
          ) : (
            <span className="font-semibold text-white/80 text-xs uppercase tracking-wider">Pay</span>
          )}
        </div>
        <div className="font-semibold text-[40px] tabular leading-[46px] tracking-tight">{amount}</div>
        <div className="text-white/72">{what}</div>
        {method && (
          <button
            type="button"
            onClick={state === "open" ? onMethod : undefined}
            disabled={state !== "open" || !onMethod}
            className="-ml-2 inline-flex items-center gap-2 self-start rounded-full px-2 py-1 text-sm outline-none enabled:hover:bg-white/12 focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <CreditCardIcon className="size-4 text-white/72" />
            {method}
            {state === "open" && onMethod && <ChevronDownIcon className="size-3 text-white/72" />}
          </button>
        )}
        <div className="pt-1">
          {state === "open" || state === "paying" ? (
            <SwipeDecide light title={state === "paying" ? "Paying…" : "Swipe to pay"} label={`Pay ${amount}`} disabled={state === "paying"} onAllow={onPay} back={onDecline && { word: "Not now", onBack: onDecline }} />
          ) : (
            <div className="font-semibold">{state === "paid" ? (note ?? "Approved") : state === "declined" ? "Declined" : "Expired"}</div>
          )}
        </div>
      </div>
    </div>
  );
}
