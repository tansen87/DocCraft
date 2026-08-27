import { useCallback, useRef } from "react";
import { Loader2 } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThemeToggle } from "@/components/theme-toggle";
import { LanguageToggle } from "@/components/language-toggle";
import { HeaderActions } from "@/components/header-actions";
import { WindowControls } from "@/components/layout/window-controls";
import { useI18n } from "@/i18n";
import { useGlobalTasks } from "@/lib/global-task";
import { useGlassOpacity } from "@/lib/glass-opacity";

export type WorkspaceTab = "pdftomd" | "imgtomd" | "mdtoexcel" | "settings";

interface AppHeaderProps {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
}

export function AppHeader({ activeTab, onTabChange }: AppHeaderProps) {
  const { t } = useI18n();
  const opacity = useGlassOpacity();
  const tasks = useGlobalTasks();
  const dragRef = useRef<{ x: number; y: number; dragging: boolean } | null>(
    null,
  );

  const onDragPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      dragRef.current = { x: e.clientX, y: e.clientY, dragging: false };
    },
    [],
  );

  const onDragPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.dragging) return;
      const dx = Math.abs(e.clientX - d.x);
      const dy = Math.abs(e.clientY - d.y);
      if (dx > 3 || dy > 3) {
        d.dragging = true;
        void getCurrentWindow().startDragging().catch(() => {});
      }
    },
    [],
  );

  const onDragPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const onDragDoubleClick = useCallback(() => {
    void getCurrentWindow().toggleMaximize().catch(() => {});
  }, []);

  return (
    <header
      className="sticky top-0 z-20 glass-panel glass-blur flex h-12 items-center gap-2 border-b border-border/30 px-2 transition-colors hover:bg-green-500/15"
      style={{ "--glass-bg-opacity": opacity / 100 } as React.CSSProperties}
    >
      <Tabs
        value={activeTab}
        onValueChange={(v) => onTabChange(v as WorkspaceTab)}
      >
        <TabsList>
          <TabsTrigger value="pdftomd">{t("tabs.pdftomd")}</TabsTrigger>
          <TabsTrigger value="imgtomd">{t("tabs.imgtomd")}</TabsTrigger>
          <TabsTrigger value="mdtoexcel">{t("tabs.mdtoexcel")}</TabsTrigger>
          <TabsTrigger value="settings">{t("tabs.settings")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Running background tasks - click to jump back to that workspace. */}
      {[...tasks.entries()].map(([tab, text]) => (
        <button
          key={tab}
          type="button"
          onClick={() => onTabChange(tab)}
          className="flex shrink-0 items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          <Loader2 className="size-3 animate-spin" />
          <span className="font-medium">{t(`tabs.${tab}`)}</span>
          {text ? <span className="font-mono">{text}</span> : null}
        </button>
      ))}

      {/* Drag region — fills the remaining space so the header is draggable. */}
      <div
        className="min-w-16 flex-1 self-stretch"
        onPointerDown={onDragPointerDown}
        onPointerMove={onDragPointerMove}
        onPointerUp={onDragPointerUp}
        onDoubleClick={onDragDoubleClick}
      />

      <div className="flex items-center gap-1">
        <HeaderActions />
        <LanguageToggle />
        <ThemeToggle />
        <WindowControls />
      </div>
    </header>
  );
}
