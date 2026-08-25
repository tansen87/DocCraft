import {
  ChevronLeft,
  ChevronRight,
  Grid2X2,
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
import { useI18n } from "@/i18n";

interface DrawTableToolbarProps {
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onClear: () => void;
  onExtract: () => void;
  onExtractFirst5: () => void;
  /** Which extraction is currently running (`null` when idle). */
  extracting: "all" | "first5" | null;
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
  onExtractFirst5,
  extracting,
  hasLines,
  currentPage,
  pageCount,
  onPrevPage,
  onNextPage,
}: DrawTableToolbarProps) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1.5 rounded-lg glass-panel px-2 py-1.5">
      {/* Instruction */}
      <span className="px-1 text-xs text-muted-foreground">
        {t("drawtable.instruction")}
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
        <TooltipContent>{t("drawtable.undo")}</TooltipContent>
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
        <TooltipContent>{t("drawtable.redo")}</TooltipContent>
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
        <TooltipContent>{t("drawtable.clearAll")}</TooltipContent>
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
        <TooltipContent>{t("drawtable.prevPage")}</TooltipContent>
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
        <TooltipContent>{t("drawtable.nextPage")}</TooltipContent>
      </Tooltip>

      <div className="flex-1" />

      {/* Extract first 5 pages (preview) button */}
      <Button
        size="sm"
        variant="secondary"
        disabled={!hasLines || extracting !== null}
        onClick={() => onExtractFirst5()}
        className="gap-1.5"
      >
        {extracting === "first5" ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Grid2X2 className="size-3.5" />
        )}
        {extracting === "first5"
          ? t("drawtable.extractingFirst5")
          : t("drawtable.extractFirst5")}
      </Button>

      {/* Extract button */}
      <Button
        size="sm"
        variant="secondary"
        disabled={!hasLines || extracting !== null}
        onClick={() => onExtract()}
        className="gap-1.5"
      >
        {extracting === "all" ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Grid3X3 className="size-3.5" />
        )}
        {extracting === "all"
          ? t("drawtable.extracting")
          : t("drawtable.extract")}
      </Button>
    </div>
  );
}
