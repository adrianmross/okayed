import { Popover, PopoverContent, PopoverTrigger } from "@okayed/design/ui/popover";
import { InfoIcon } from "lucide-react";

/** The detail behind a heading, a tap away instead of under it. */
export function Info({ children }: { children: string }) {
  return (
    <Popover>
      <PopoverTrigger aria-label="More about this" className="ml-auto grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <InfoIcon className="size-4" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 text-muted-foreground text-sm">{children}</PopoverContent>
    </Popover>
  );
}
