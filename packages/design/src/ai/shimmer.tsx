// After AI Elements' Shimmer, without motion: a CSS sweep that stops for reduced-motion users.
import type { HTMLAttributes } from "react";
import { cn } from "../lib/utils";

export const Shimmer = ({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) => (
  <span
    className={cn(
      "inline-block bg-[linear-gradient(90deg,var(--muted-foreground)_0%,var(--foreground)_50%,var(--muted-foreground)_100%)] bg-[length:200%_100%] bg-clip-text text-transparent motion-safe:animate-[shimmer_1.8s_linear_infinite]",
      className,
    )}
    {...props}
  >
    {children}
    <style>{"@keyframes shimmer{from{background-position:100% 0}to{background-position:-100% 0}}"}</style>
  </span>
);
