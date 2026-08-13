import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThemeToggle } from "@/components/theme-toggle";

export type WorkspaceTab = "pdftomd" | "mdtoexcel" | "settings";

interface AppHeaderProps {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
}

export function AppHeader({ activeTab, onTabChange }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-20 flex h-12 items-center gap-4 border-b bg-background/80 px-4 backdrop-blur">
      <Tabs
        value={activeTab}
        onValueChange={(v) => onTabChange(v as WorkspaceTab)}
      >
        <TabsList>
          <TabsTrigger value="pdftomd">PDF转MD</TabsTrigger>
          <TabsTrigger value="mdtoexcel">MD转Excel</TabsTrigger>
          <TabsTrigger value="settings">设置</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="ml-auto">
        <ThemeToggle />
      </div>
    </header>
  );
}
