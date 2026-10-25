/** Follows the system light/dark setting by toggling `.dark` on <html>, as shadcn components expect. */
export function followSystemTheme(): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => document.documentElement.classList.toggle("dark", mq.matches);
  apply();
  mq.addEventListener("change", apply);
  return () => mq.removeEventListener("change", apply);
}
