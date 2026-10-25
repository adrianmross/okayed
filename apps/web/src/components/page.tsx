import type { ReactNode } from "react";
import { cn } from "@okayed/design/lib/utils";

/** A view's frame: a title, a sentence, actions on the right, then the content. */
export function Page({ title, description, actions, children, className }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className={cn("mx-auto w-full max-w-5xl px-4 pt-6 pb-16 md:px-8 md:pt-10", className)}>
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h1 className="font-semibold text-2xl md:text-3xl">{title}</h1>
            {description && <p className="max-w-[60ch] text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Section({ title, description, action, children }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="font-semibold text-base">{title}</h2>
          {description && <p className="text-muted-foreground text-sm">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
