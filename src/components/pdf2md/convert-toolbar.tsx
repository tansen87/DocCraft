import {
  FileText,
  Columns3Cog,
  Loader2,
  WandSparkles,
  Trash2,
} from "lucide-react";

import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { GlassPanel } from "@/components/ui/glass-panel";

interface ConvertToolbarProps {
  name: string;
  path: string;
  busy: boolean;
  converting: boolean;
  drawMode: boolean;
  onToggleDrawMode: () => void;
  onConvert: () => void;
  onClear?: () => void;
}

export function ConvertToolbar({
  name,
  path,
  busy,
  converting,
  drawMode,
  onToggleDrawMode,
  onConvert,
  onClear,
}: ConvertToolbarProps) {
  const { t } = useI18n();

  return (
    <GlassPanel className="flex items-center gap-3 rounded-xl px-3 py-2">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <FileText className="size-4" />
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="truncate text-xs text-muted-foreground">{path}</p>
          </div>
        </TooltipTrigger>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          {onClear ? (
            <Button variant="ghost" size="sm" onClick={onClear}>
              <Trash2 />
            </Button>
          ) : null}
        </TooltipTrigger>
        <TooltipContent>{t("toolbar.remove")}</TooltipContent>
      </Tooltip>

      {/* Draw Table mode toggle - styled like the header tabs */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={busy}
            onClick={onToggleDrawMode}
            className={cn(
              "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 gap-1.5",
              drawMode
                ? "bg-background text-foreground shadow-sm"
                : "bg-secondary text-secondary-foreground hover:bg-secondary/80",
            )}
          >
            <Columns3Cog className="size-4" />
            {t("toolbar.drawTable")}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {drawMode ? t("toolbar.exitDraw") : t("toolbar.enterDraw")}
        </TooltipContent>
      </Tooltip>

      <Button
        onClick={onConvert}
        disabled={busy || drawMode}
        className="shrink-0"
        variant="secondary"
      >
        {converting ? <Loader2 className="animate-spin" /> : <WandSparkles />}
        {t("toolbar.extractToMarkdown")}
      </Button>
    </GlassPanel>
  );
}
