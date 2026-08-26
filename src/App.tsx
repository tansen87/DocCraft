import { useCallback, useEffect, useState } from "react";
import { Toaster } from "sonner";
import { useTheme } from "next-themes";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { AppHeader, type WorkspaceTab } from "@/components/layout/app-header";
import { BatchView } from "@/views/pdf-to-md";
import { ImageToMdView } from "@/views/image-to-md";
import { MdToXlsxView } from "@/views/md-to-xlsx";
import { SettingsView } from "@/views/settings";
import { getAppSettings } from "@/lib/ipc";

const TABS: WorkspaceTab[] = ["pdftomd", "imgtomd", "mdtoexcel", "settings"];
const TAB_STORAGE_KEY = "doccraft-active-tab";

function initialTab(): WorkspaceTab {
  const saved = localStorage.getItem(TAB_STORAGE_KEY);
  return TABS.includes(saved as WorkspaceTab)
    ? (saved as WorkspaceTab)
    : "pdftomd";
}

function App() {
  const [tab, setTabState] = useState<WorkspaceTab>(initialTab);
  const { resolvedTheme } = useTheme();
  const [glassOpacity, setGlassOpacity] = useState(100);

  const setTab = useCallback((next: WorkspaceTab) => {
    setTabState(next);
    localStorage.setItem(TAB_STORAGE_KEY, next);
  }, []);

  // Ensure the main window is frameless and shadowless (Tauri config may not
  // apply instantly on all platforms).
  useEffect(() => {
    const win = getCurrentWindow();
    void win.setDecorations(false).catch(() => {});
    void win.setShadow(false).catch(() => {});
  }, []);

  // Load glass opacity from settings and refresh on settings change.
  useEffect(() => {
    const load = () =>
      getAppSettings()
        .then((s) => setGlassOpacity(s.mainWindowOpacity ?? 100))
        .catch(() => {});
    void load();
    window.addEventListener("doccraft:settings-saved", load);
    return () => window.removeEventListener("doccraft:settings-saved", load);
  }, []);

  // Ctrl+1..4 jumps straight to a workspace tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const idx = ["1", "2", "3", "4"].indexOf(e.key);
      if (idx === -1) return;
      e.preventDefault();
      setTab(TABS[idx]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setTab]);

  return (
    <div
      className="relative flex h-screen flex-col overflow-hidden text-foreground"
      style={{
        clipPath: "inset(0 round 0.75rem)",
        backgroundColor: `color-mix(in srgb, var(--background) ${glassOpacity}%, transparent)`,
      }}
    >
      <Toaster
        position="bottom-right"
        richColors
        theme={resolvedTheme === "dark" ? "dark" : "light"}
      />
      <AppHeader activeTab={tab} onTabChange={setTab} />
      <main className="flex h-[calc(100dvh-3rem)] w-full flex-col overflow-y-auto bg-white/[0.03] p-3">
        {/* Keep every view mounted so per-view state (loaded PDFs, converted
            results, queue) survives tab switches; the inactive ones are only
            hidden. */}
        <div
          className={
            tab === "pdftomd" ? "flex min-h-0 flex-1 flex-col" : "hidden"
          }
        >
          <BatchView />
        </div>
        <div
          className={
            tab === "imgtomd" ? "flex min-h-0 flex-1 flex-col" : "hidden"
          }
        >
          <ImageToMdView />
        </div>
        <div
          className={
            tab === "mdtoexcel" ? "flex min-h-0 flex-1 flex-col" : "hidden"
          }
        >
          <MdToXlsxView />
        </div>
        <div
          className={
            tab === "settings" ? "flex min-h-0 flex-1 flex-col" : "hidden"
          }
        >
          <SettingsView />
        </div>
      </main>
    </div>
  );
}

export default App;
