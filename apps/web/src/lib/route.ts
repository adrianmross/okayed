import { useEffect, useState } from "react";

export const ROUTES = ["chat", "policies", "activity", "settings"] as const;
export type Route = (typeof ROUTES)[number];

const read = (): Route => {
  const h = location.hash.replace(/^#/, "");
  return (ROUTES as readonly string[]).includes(h) ? (h as Route) : "chat";
};

/** The current view, kept in the URL hash so each one can be bookmarked or shared. */
export function useRoute(): [Route, (r: Route) => void] {
  const [route, set] = useState<Route>(read);
  useEffect(() => {
    const on = () => set(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return [route, (r) => (location.hash = r)];
}
