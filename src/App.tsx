import {
  memo,
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
} from "react";
import { Toaster } from "sonner";
import { useTheme } from "next-themes";
import { Effect, getCurrentWindow } from "@tauri-apps/api/window";

import { AppHeader, type WorkspaceTab } from "@/components/layout/app-header";
import { BatchView } from "@/views/pdf-to-md";
import { ImageToMdView } from "@/views/image-to-md";
import { MdToXlsxView } from "@/views/md-to-xlsx";
import { SettingsView } from "@/views/settings";
import { getAppSettings } from "@/lib/ipc";
import { GlassOpacityContext } from "@/lib/glass-opacity";

const TABS: WorkspaceTab[] = ["pdftomd", "imgtomd", "mdtoexcel", "settings"];
const TAB_STORAGE_KEY = "doccraft-active-tab";

// The tab views stay mounted (to keep per-tab state when switching), so memoize
// them: re-rendering App (theme toggle, glass-opacity preview, ...) must not
// reconcile the whole workspace tree again. They still update on language
// changes because they consume the i18n context.
const BatchViewView = memo(BatchView);
const ImageToMdViewView = memo(ImageToMdView);
const MdToXlsxViewView = memo(MdToXlsxView);
const SettingsViewView = memo(SettingsView);

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
  const [glassBlurEnabled, setGlassBlurEnabled] = useState(true);

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

  // CSS backdrop-filter cannot sample the desktop behind a transparent
  // WebView2 window on Windows (especially Win11), which is why the glass-blur
  // panels lose their blur there. Apply the native DWM acrylic effect so the
  // frosted-glass blur works on both Win10/11. The `color` tint only takes
  // effect on Win10 v1903+ (ignored on Win11); it follows the app theme.
  //
  // Acrylic makes dragging/resizing laggy (DWM recomposites the effect every
  // frame), so the effect is cleared while the window is moving/resizing and
  // re-applied shortly after the gesture settles.
  //
  // The user-controlled blur toggle is `glassBlurEnabled`; when it is off the
  // acrylic is removed too so "no blur" is honest on every platform.
  useEffect(() => {
    if (!navigator.userAgent.includes("Windows") || !resolvedTheme) return;
    const win = getCurrentWindow();
    if (!glassBlurEnabled) {
      void win.clearEffects().catch(() => {});
      return;
    }
    const tint: [number, number, number, number] =
      resolvedTheme === "dark" ? [30, 32, 36, 120] : [245, 245, 247, 120];
    const apply = () => {
      void win
        .setEffects({ effects: [Effect.Acrylic], color: tint })
        .catch(() => {});
    };
    let moving = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const onMove = () => {
      if (!moving) {
        moving = true;
        void win.clearEffects().catch(() => {});
      }
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => {
        moving = false;
        apply();
      }, 150);
    };
    apply();
    const unlistenMove = win.onMoved(onMove);
    const unlistenResize = win.onResized(onMove);
    return () => {
      void unlistenMove.then((fn) => fn());
      void unlistenResize.then((fn) => fn());
      if (settle) clearTimeout(settle);
    };
  }, [resolvedTheme, glassBlurEnabled]);

  // Load glass opacity/blur from settings and refresh on settings change.
  useEffect(() => {
    const load = () =>
      getAppSettings()
        .then((s) => {
          setGlassOpacity(s.mainWindowOpacity ?? 100);
          setGlassBlurEnabled(s.glassBlurEnabled ?? true);
        })
        .catch(() => {});
    void load();
    window.addEventListener("doccraft:settings-saved", load);
    // Live preview: slider drag updates opacity without saving.
    const onPreview = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail?.mainWindow === "number") {
        setGlassOpacity(detail.mainWindow);
      }
      if (typeof detail?.blur === "boolean") {
        setGlassBlurEnabled(detail.blur);
      }
    };
    window.addEventListener("doccraft:opacity-preview", onPreview);
    return () => {
      window.removeEventListener("doccraft:settings-saved", load);
      window.removeEventListener("doccraft:opacity-preview", onPreview);
    };
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
    <GlassOpacityContext value={glassOpacity}>
      <div
        className="relative flex h-screen flex-col overflow-hidden text-foreground"
        style={
          {
            clipPath: "inset(0 round 0.75rem)",
            backgroundColor: `color-mix(in srgb, var(--background) ${glassOpacity}%, transparent)`,
            "--glass-blur": `${glassBlurEnabled ? 20 : 0}px`,
          } as CSSProperties
        }
      >
        <Toaster
          position="bottom-right"
          richColors
          theme={resolvedTheme === "dark" ? "dark" : "light"}
        />
        <AppHeader activeTab={tab} onTabChange={setTab} />
        <main className="flex h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden bg-white/[0.03] p-1">
          <div
            className={
              tab === "pdftomd" ? "flex min-h-0 flex-1 flex-col" : "hidden"
            }
          >
            <BatchViewView />
          </div>
          <div
            className={
              tab === "imgtomd" ? "flex min-h-0 flex-1 flex-col" : "hidden"
            }
          >
            <ImageToMdViewView />
          </div>
          <div
            className={
              tab === "mdtoexcel" ? "flex min-h-0 flex-1 flex-col" : "hidden"
            }
          >
            <MdToXlsxViewView />
          </div>
          <div
            className={
              tab === "settings" ? "flex min-h-0 flex-1 flex-col" : "hidden"
            }
          >
            <SettingsViewView />
          </div>
        </main>
      </div>
    </GlassOpacityContext>
  );
}

export default App;
