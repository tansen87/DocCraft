import { Loader2 } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThemeToggle } from "@/components/theme-toggle";
import { LanguageToggle } from "@/components/language-toggle";
import { HeaderActions } from "@/components/header-actions";
import { useI18n } from "@/i18n";
import { useGlobalTasks } from "@/lib/global-task";

export type WorkspaceTab = "pdftomd" | "imgtomd" | "mdtoexcel" | "settings";

interface AppHeaderProps {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
}

export function AppHeader({ activeTab, onTabChange }: AppHeaderProps) {
  const { t } = useI18n();
  const tasks = useGlobalTasks();

  return (
    <header className="sticky top-0 z-20 flex h-12 items-center gap-4 bg-background/80 px-4 backdrop-blur">
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

      <div className="ml-auto flex items-center gap-1">
        <HeaderActions />
        <LanguageToggle />
        <ThemeToggle />
      </div>
    </header>
  );
}
