import { FileText, Grid3X3, Loader2, WandSparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2 shadow-sm">
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
      {onClear ? (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClear}
          className="shrink-0"
        >
          <X />
        </Button>
      ) : null}

      {/* Draw Table mode toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={drawMode ? "default" : "outline"}
            size="sm"
            onClick={onToggleDrawMode}
            className="shrink-0 gap-1.5"
          >
            <Grid3X3 className="size-4" />
            划线表格
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {drawMode ? "退出划线模式" : "手动划线定义表格区域"}
        </TooltipContent>
      </Tooltip>

      <Button
        onClick={onConvert}
        disabled={busy || drawMode}
        className="shrink-0"
        variant="secondary"
      >
        {converting ? <Loader2 className="animate-spin" /> : <WandSparkles />}
        转换为 Markdown
      </Button>
    </div>
  );
}
