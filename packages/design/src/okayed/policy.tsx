import { MoreHorizontalIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../lib/utils";
import { actionMeta } from "./actions";

export interface PolicyTileProps extends ComponentProps<"button"> {
  act: string;
  title: string;
  subtitle: string;
  effect: "allow" | "ask" | "deny";
  spent?: boolean;
}

const EFFECT = { allow: "Goes ahead", ask: "Asks you", deny: "Never" };

/** A policy in the library, as Shortcuts shows a shortcut: a colour, an icon, a name, and what it does. */
export function PolicyTile({ act, title, subtitle, effect, spent, className, ...props }: PolicyTileProps) {
  const meta = actionMeta(act);
  const Icon = meta.icon;
  return (
    <button
      type="button"
      data-tone={effect === "deny" ? "any" : meta.tone}
      className={cn(
        "okayed-tile group relative flex aspect-[1.55] w-full flex-col justify-between rounded-2xl p-3.5 text-left shadow-sm outline-none transition hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
      {...props}
    >
      <span className="flex items-start justify-between">
        <Icon className="size-6" strokeWidth={2.2} />
        <span className="flex items-center gap-1">
          <span className={cn("rounded-full bg-white/20 px-2 py-0.5 font-medium text-[11px] backdrop-blur-sm", spent && "bg-black/25")}>{spent ? "Budget spent" : EFFECT[effect]}</span>
          <MoreHorizontalIcon className="size-5 opacity-70" />
        </span>
      </span>
      <span>
        <span className="block font-semibold text-[15px] leading-tight">{title}</span>
        <span className="mt-0.5 block truncate text-[13px] text-white/80">{subtitle}</span>
      </span>
    </button>
  );
}

/** The "+" tile at the end of the library. */
export function NewPolicyTile({ className, children = "New policy", ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn("flex aspect-[1.55] w-full flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed text-muted-foreground transition hover:border-primary/50 hover:text-primary", className)}
      {...props}
    >
      <span className="text-3xl leading-none">+</span>
      <span className="font-medium text-sm">{children}</span>
    </button>
  );
}
