import {
  ChevronLeft,
  ChevronRight,
  Grid3X3,
  Loader2,
  RotateCcw,
  Trash2,
} from "lucide-react";

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
  /** Current page number (1-indexed) */
  currentPage: number;
  /** Total pages available for drawing */
  pageCount: number;
  /** Navigate to the previous page */
  onPrevPage: () => void;
  /** Navigate to the next page */
  onNextPage: () => void;
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
  currentPage,
  pageCount,
  onPrevPage,
  onNextPage,
}: DrawTableToolbarProps) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg border bg-card px-2 py-1.5 shadow-sm">
      {/* Instruction */}
      <span className="px-1 text-xs text-muted-foreground">
        点击添加竖线 - 双击删除 - 拖拽调整位置
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
        <TooltipContent>重做 (Ctrl+Y)</TooltipContent>
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

      <div className="mx-1 h-5 w-px bg-border" />

      {/* Page navigation */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={onPrevPage}
            className="inline-flex items-center justify-center rounded-md px-1 py-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronLeft className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>上一页</TooltipContent>
      </Tooltip>
      <span className="text-xs tabular-nums text-muted-foreground">
        {currentPage} / {pageCount}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={currentPage >= pageCount}
            onClick={onNextPage}
            className="inline-flex items-center justify-center rounded-md px-1 py-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronRight className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>下一页</TooltipContent>
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
