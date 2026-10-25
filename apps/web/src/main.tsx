import "./styles.css";
import { Toaster } from "@okayed/design/ui/sonner";
import { TooltipProvider } from "@okayed/design/ui/tooltip";
import { followSystemTheme } from "@okayed/design/lib/theme";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";

followSystemTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={300}>
      <App />
      <Toaster position="top-center" />
    </TooltipProvider>
  </StrictMode>,
);
