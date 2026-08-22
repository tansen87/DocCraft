import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { LanguageProvider } from "@/i18n";
import { SnipOverlay } from "@/components/snip/snip-overlay";
import App from "./App";
import "./index.css";

/** True when this webview is a per-monitor region-selection overlay. */
function isSnipWindow(): boolean {
  try {
    return getCurrentWebviewWindow().label.startsWith("snip-");
  } catch {
    return false;
  }
}

const content = isSnipWindow() ? (
  <LanguageProvider>
    <ThemeProvider attribute="class" defaultTheme="dark">
      <SnipOverlay />
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
