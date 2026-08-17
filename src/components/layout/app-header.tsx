import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThemeToggle } from "@/components/theme-toggle";
import { LanguageToggle } from "@/components/language-toggle";
import { useI18n } from "@/i18n";

export type WorkspaceTab = "pdftomd" | "mdtoexcel" | "settings";

interface AppHeaderProps {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
}

export function AppHeader({ activeTab, onTabChange }: AppHeaderProps) {
  const { t } = useI18n();

  return (
    <header className="sticky top-0 z-20 flex h-12 items-center gap-4 bg-background/80 px-4 backdrop-blur">
      <Tabs
        value={activeTab}
        onValueChange={(v) => onTabChange(v as WorkspaceTab)}
      >
        <TabsList>
          <TabsTrigger value="pdftomd">{t("tabs.pdftomd")}</TabsTrigger>
          <TabsTrigger value="mdtoexcel">{t("tabs.mdtoexcel")}</TabsTrigger>
          <TabsTrigger value="settings">{t("tabs.settings")}</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="ml-auto flex items-center gap-1">
        <LanguageToggle />
        <ThemeToggle />
      </div>
    </header>
  );
}
