// Adapted from AI Elements (vercel/ai-elements, Apache-2.0): the same collapsible tool call, with okayed's labels
// and colours, and a plain <pre> instead of a Shiki code block.
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { CheckCircle2Icon, ChevronDownIcon, CircleIcon, ClockIcon, LoaderIcon, ShieldCheckIcon, XCircleIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";
import { Badge } from "../ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "../lib/utils";

export type ToolPart = ToolUIPart | DynamicToolUIPart;
export type ToolState = ToolPart["state"];

export const Tool = ({ className, ...props }: ComponentProps<typeof Collapsible>) => (
  <Collapsible className={cn("group not-prose w-full rounded-xl border bg-card", className)} {...props} />
);

const LABELS: Record<ToolState, string> = {
  "approval-requested": "Waiting for you",
  "approval-responded": "Okayed",
  "input-available": "Running",
  "input-streaming": "Preparing",
  "output-available": "Done",
  "output-denied": "Not allowed",
  "output-error": "Error",
};

const ICONS: Record<ToolState, ReactNode> = {
  "approval-requested": <ClockIcon className="size-3.5 text-ask" />,
  "approval-responded": <ShieldCheckIcon className="size-3.5 text-seal" />,
  "input-available": <LoaderIcon className="size-3.5 animate-spin" />,
  "input-streaming": <CircleIcon className="size-3.5" />,
  "output-available": <CheckCircle2Icon className="size-3.5 text-allow" />,
  "output-denied": <XCircleIcon className="size-3.5 text-deny" />,
  "output-error": <XCircleIcon className="size-3.5 text-deny" />,
};

export const ToolStatus = ({ state }: { state: ToolState }) => (
  <Badge className="gap-1.5 rounded-full font-medium" variant="secondary">
    {ICONS[state]}
    {LABELS[state]}
  </Badge>
);

export type ToolHeaderProps = ComponentProps<typeof CollapsibleTrigger> & { title: ReactNode; icon?: ReactNode; state: ToolState };

export const ToolHeader = ({ className, title, icon, state, ...props }: ToolHeaderProps) => (
  <CollapsibleTrigger className={cn("flex w-full items-center justify-between gap-3 p-2.5 pr-3 text-left", className)} {...props}>
    <span className="flex min-w-0 items-center gap-2.5">
      {icon}
      <span className="truncate font-medium text-sm">{title}</span>
      <ToolStatus state={state} />
    </span>
    <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
  </CollapsibleTrigger>
);

export const ToolContent = ({ className, ...props }: ComponentProps<typeof CollapsibleContent>) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-3 border-t p-3 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className,
    )}
    {...props}
  />
);

const Code = ({ value }: { value: unknown }) => (
  <pre className="max-h-64 overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-xs leading-relaxed">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>
);

export const ToolInput = ({ className, input, ...props }: ComponentProps<"div"> & { input: ToolPart["input"] }) => (
  <div className={cn("space-y-1.5", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Asked with</h4>
    <Code value={input} />
  </div>
);

export const ToolOutput = ({ className, output, errorText, ...props }: ComponentProps<"div"> & { output: ToolPart["output"]; errorText: ToolPart["errorText"] }) => {
  if (!(output || errorText)) return null;
  return (
    <div className={cn("space-y-1.5", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{errorText ? "Error" : "Result"}</h4>
      {errorText ? <div className="rounded-lg bg-destructive/10 p-3 text-destructive text-sm">{errorText}</div> : isValidElement(output) ? output : <Code value={output} />}
    </div>
  );
};
