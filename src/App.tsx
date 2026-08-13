import { useState } from "react";
import { Toaster } from "sonner";

import { AppHeader, type WorkspaceTab } from "@/components/layout/app-header";
import { BatchView } from "@/views/pdf-to-md";
import { MdToXlsxView } from "@/views/md-to-xlsx";
import { SettingsView } from "@/views/settings";

function App() {
  const [tab, setTab] = useState<WorkspaceTab>("pdftomd");

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <Toaster position="top-center" richColors />
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
