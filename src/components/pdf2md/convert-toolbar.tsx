import { FileText, Grid3X3, Loader2, WandSparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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

      {/* Draw Table mode toggle — styled like the header tabs */}
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
            <Grid3X3 className="size-4" />
            划线表格
          </button>
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
        提取为 Markdown
      </Button>
    </div>
  );
}
