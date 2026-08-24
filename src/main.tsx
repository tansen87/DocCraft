import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { LanguageProvider } from "@/i18n";
import { SnipOverlay } from "@/components/snip/snip-overlay";
import { SnipResultWindow } from "@/components/snip/snip-result-window";
import App from "./App";
import "./index.css";

type RoutedWindow = "app" | "snip-overlay" | "snip-result";

/** Which UI this webview should render, based on its Tauri window label. */
function routeWindow(): RoutedWindow {
  try {
    const label = getCurrentWebviewWindow().label;
    if (label === "snip-result") return "snip-result";
    if (label.startsWith("snip-")) return "snip-overlay";
  } catch {
    /* no webview window context - fall through to the app shell */
  }
  return "app";
}

const routed = routeWindow();

const content =
  routed === "snip-overlay" ? (
    <LanguageProvider>
      <ThemeProvider attribute="class" defaultTheme="dark">
        <SnipOverlay />
      </ThemeProvider>
    </LanguageProvider>
  ) : routed === "snip-result" ? (
    <LanguageProvider>
      <ThemeProvider attribute="class" defaultTheme="light">
        <SnipResultWindow />
      </ThemeProvider>
    </LanguageProvider>
  ) : (
    <React.StrictMode>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <LanguageProvider>
          <App />
        </LanguageProvider>
      </ThemeProvider>
    </React.StrictMode>
  );

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  content,
);
