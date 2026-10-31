import { Logo } from "./components/logo";
import { Badge } from "@okayed/design/ui/badge";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@okayed/design/ui/sidebar";
import { ActivityIcon, MessageCircleIcon, Settings2Icon, ShieldCheckIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { OkayedProvider, useOkayed } from "./lib/okayed";
import { useRoute, type Route } from "./lib/route";
import { loadSession, saveSession, type Session } from "./lib/session";
import { ActivityView } from "./views/activity";
import { ChatView } from "./views/chat";
import { Connect } from "./views/connect";
import { RulesView } from "./views/rules";
import { SettingsView } from "./views/settings";
import { Welcome } from "./views/welcome";

const NAV: { route: Route; label: string; icon: typeof MessageCircleIcon }[] = [
  { route: "chat", label: "Chat", icon: MessageCircleIcon },
  { route: "rules", label: "Rules", icon: ShieldCheckIcon },
  { route: "activity", label: "Activity", icon: ActivityIcon },
  { route: "settings", label: "Settings", icon: Settings2Icon },
];

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const signOut = useCallback(() => {
    saveSession(null);
    setSession(null);
  }, []);
  // An MCP client sent the person here to approve it (OAuth consent from /authorize).
  const connecting = location.hash.startsWith("#connect");
  if (!session) {
    return (
      <Welcome
        {...(connecting ? { note: "An app wants to connect to your okayed. Start, or use your account, and you'll be asked to allow it." } : {})}
        onSession={(s) => {
          saveSession(s);
          setSession(s);
        }}
      />
    );
  }
  if (connecting) return <Connect session={session} />;
  return (
    <OkayedProvider session={session} onSignOut={signOut}>
      <Shell />
    </OkayedProvider>
  );
}

function Shell() {
  const [route, go] = useRoute();
  const { snap } = useOkayed();
  const waiting = snap?.cards.filter((c) => c.status === "open" && (c.kind === "grant" || c.kind === "policy")).length ?? 0;
  const View = route === "chat" ? null : { rules: RulesView, activity: ActivityView, settings: SettingsView }[route];
  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader>
          <a href="#chat" className="flex items-center gap-2 px-1.5 py-1 font-semibold text-lg tracking-tight">
            <Logo className="size-7 shrink-0" />
            <span className="group-data-[collapsible=icon]:hidden">okayed</span>
          </a>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV.map((n) => (
                  <SidebarMenuItem key={n.route}>
                    <SidebarMenuButton isActive={route === n.route} tooltip={n.label} onClick={() => go(n.route)} className="h-9">
                      <n.icon />
                      <span>{n.label}</span>
                    </SidebarMenuButton>
                    {n.route === "activity" && waiting > 0 && <SidebarMenuBadge className="bg-ask/20 text-foreground">{waiting}</SidebarMenuBadge>}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="group-data-[collapsible=icon]:hidden">
          {snap?.paused ? (
            <Badge variant="secondary" className="justify-center bg-deny/12 py-1 text-deny">Rules paused</Badge>
          ) : (
            <p className="px-2 text-muted-foreground text-xs leading-relaxed">Every action an agent takes here is simulated. The permissions are real.</p>
          )}
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-h-svh overflow-hidden md:min-h-[calc(100svh-1rem)]">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:hidden">
          <SidebarTrigger />
          <span className="font-semibold">{NAV.find((n) => n.route === route)?.label}</span>
        </header>
        {/* The chat stays mounted on other pages: remounting it mid-reply lost or reordered the replies. */}
        <div className={route === "chat" ? "contents" : "hidden"}>
          <ChatView />
        </div>
        {View && <View />}
      </SidebarInset>
    </SidebarProvider>
  );
}
