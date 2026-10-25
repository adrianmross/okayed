// Adapted from AI Elements (vercel/ai-elements, Apache-2.0). Streamdown is replaced by a small renderer: replies here
// are short, and the full markdown stack (Shiki, Mermaid, KaTeX) would outweigh the app.
import type { UIMessage } from "ai";
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { Fragment } from "react";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../lib/utils";

export type MessageProps = HTMLAttributes<HTMLDivElement> & { from: UIMessage["role"] };

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn("group flex w-full max-w-[95%] flex-col gap-2", from === "user" ? "is-user ml-auto items-end" : "is-assistant", className)}
    {...props}
  />
);

export const MessageContent = ({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-[15px] leading-relaxed",
      "group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-md group-[.is-user]:bg-primary group-[.is-user]:px-4 group-[.is-user]:py-2.5 group-[.is-user]:text-primary-foreground",
      "group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

/** Inline markdown: **bold**, `code`, and bare links. Enough for an assistant's short replies. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/\S+)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{part.slice(1, -1)}</code>;
    if (/^https?:\/\//.test(part)) return <a key={i} href={part} className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer">{part}</a>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export type MessageResponseProps = HTMLAttributes<HTMLDivElement> & { children: string };

/** Paragraphs and bullet lists from plain markdown text. */
export const MessageResponse = ({ children, className, ...props }: MessageResponseProps) => {
  const blocks = children.trim().split(/\n{2,}/);
  return (
    <div className={cn("space-y-2", className)} {...props}>
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*[-*] /.test(l))) {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*] /, ""))}</li>)}
            </ul>
          );
        }
        return <p key={i}>{lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>)}</p>;
      })}
    </div>
  );
};

export const MessageActions = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("flex items-center gap-1", className)} {...props} />
);

export type MessageActionProps = ComponentProps<typeof Button> & { tooltip?: string; label?: string };

export const MessageAction = ({ tooltip, children, label, variant = "ghost", size = "icon-sm", ...props }: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
};
