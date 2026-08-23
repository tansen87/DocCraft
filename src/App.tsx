import { useCallback, useEffect, useState } from "react";
import { Toaster } from "sonner";
import { useTheme } from "next-themes";

import { AppHeader, type WorkspaceTab } from "@/components/layout/app-header";
import { BatchView } from "@/views/pdf-to-md";
import { ImageToMdView } from "@/views/image-to-md";
import { MdToXlsxView } from "@/views/md-to-xlsx";
import { SettingsView } from "@/views/settings";

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

  const setTab = useCallback((next: WorkspaceTab) => {
    setTabState(next);
    localStorage.setItem(TAB_STORAGE_KEY, next);
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
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <Toaster
        position="bottom-right"
        richColors
        theme={resolvedTheme === "dark" ? "dark" : "light"}
      />
      <AppHeader activeTab={tab} onTabChange={setTab} />
      <main className="flex h-[calc(100dvh-3rem)] w-full flex-col overflow-y-auto p-3">
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
