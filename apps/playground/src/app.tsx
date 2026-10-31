import { ToggleGroup, ToggleGroupItem } from "@okayed/design/ui/toggle-group";
import { useEffect, useState } from "react";
import { AskView } from "./ask";
import { OrgsView } from "./orgs";
import { ComponentsView } from "./components";
import { WordsView } from "./words";

// Served at /playground by the same Worker as the demo; in development the demo is on its own port.
const WEB = (import.meta.env.VITE_WEB_URL as string | undefined) ?? (import.meta.env.DEV ? "http://localhost:5173" : "../");
type View = "ask" | "words" | "orgs" | "components";
const VIEWS: View[] = ["ask", "words", "orgs", "components"];
const read = (): View => VIEWS.find((v) => `#${v}` === location.hash) ?? "ask";

export function App() {
  const [view, setView] = useState<View>(read);
  useEffect(() => {
    const on = () => setView(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3 md:px-8">
          <a href="#ask" className="flex items-center gap-2 font-semibold text-lg">
            <img src="./favicon.svg" alt="" className="size-7" />
            okayed <span className="font-normal text-muted-foreground">playground</span>
          </a>
          <ToggleGroup type="single" variant="outline" size="sm" value={view} onValueChange={(v) => v && (location.hash = v)} className="ml-auto">
            <ToggleGroupItem value="ask">Ask your rules</ToggleGroupItem>
            <ToggleGroupItem value="words">Words → grant</ToggleGroupItem>
            <ToggleGroupItem value="orgs">Sign-in &amp; orgs</ToggleGroupItem>
            <ToggleGroupItem value="components">Components</ToggleGroupItem>
          </ToggleGroup>
          <a href={WEB} className="text-muted-foreground text-sm underline-offset-4 hover:underline">Try the demo ↗</a>
        </div>
      </header>
      {view === "ask" ? <AskView /> : view === "words" ? <WordsView /> : view === "orgs" ? <OrgsView /> : <ComponentsView />}
    </div>
  );
}
