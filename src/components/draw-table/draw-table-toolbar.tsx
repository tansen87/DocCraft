import { Grid3X3, Loader2, RotateCcw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface DrawTableToolbarProps {
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onClear: () => void;
  onExtract: () => void;
  extracting: boolean;
  hasLines: boolean;
}

export function DrawTableToolbar({
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onClear,
  onExtract,
  extracting,
  hasLines,
}: DrawTableToolbarProps) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg border bg-card px-2 py-1.5 shadow-sm">
      {/* Instruction */}
      <span className="px-1 text-xs text-muted-foreground">
        点击添加竖线，双击删除，拖拽调整位置
      </span>

      <div className="mx-1 h-5 w-px bg-border" />

      {/* Undo / Redo */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7"
            disabled={!canUndo}
            onClick={onUndo}
          >
            <RotateCcw className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>撤销 (Ctrl+Z)</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7"
            disabled={!canRedo}
            onClick={onRedo}
          >
            <RotateCcw className="size-3.5 scale-x-[-1]" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>重做 (Ctrl+Shift+Z)</TooltipContent>
      </Tooltip>

      <div className="mx-1 h-5 w-px bg-border" />

      {/* Clear */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7"
            disabled={!hasLines}
            onClick={onClear}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>清空所有竖线</TooltipContent>
      </Tooltip>

      <div className="flex-1" />

      {/* Extract button */}
      <Button
        size="sm"
        variant="secondary"
        disabled={!hasLines || extracting}
        onClick={onExtract}
        className="gap-1.5"
      >
        {extracting ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Grid3X3 className="size-3.5" />
        )}
        {extracting ? "提取中…" : "提取表格"}
      </Button>
    </div>
  );
}
