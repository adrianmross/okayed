/** The okayed mark: a check on a cobalt tile. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="okayed-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--tile-policy-from)" />
          <stop offset="1" stopColor="var(--tile-policy-to)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#okayed-mark)" />
      <path d="M9 16.5l4.6 4.6L23 11.6" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
