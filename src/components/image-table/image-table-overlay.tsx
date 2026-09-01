import { useCallback, useEffect, useRef, useState } from "react";
import {
  Columns3,
  Loader2,
  MoveHorizontal,
  MoveVertical,
  Trash2,
  X,
} from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useI18n } from "@/i18n";
import { getAppSettings, ocrImageTable } from "@/lib/ipc";
import { recordUsage } from "@/lib/usage";
import type { ImageTableResult } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ImageTableOverlayProps {
  imagePath: string;
  onClose: () => void;
  onResult: (result: ImageTableResult) => void;
}

const VERTICAL_COLOR = "rgba(239, 68, 68, 0.85)"; // red - column separators
const HORIZONTAL_COLOR = "rgba(59, 130, 246, 0.85)"; // blue - row boundaries

interface DrawnLine {
  /** Percent (0-100) along the line's own axis. */
  pct: number;
  vertical: boolean;
}

/**
 * Full-screen overlay that shows an image and lets the user draw vertical
 * column separators AND horizontal row boundaries on it to define the table
 * grid. On confirm the image + line percentages are sent to the backend for
 * OCR + cutting.
 */
export function ImageTableOverlay({
  imagePath,
  onClose,
  onResult,
}: ImageTableOverlayProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [mode, setMode] = useState<"vertical" | "horizontal">("vertical");
  const [lines, setLines] = useState<DrawnLine[]>([]);
  const [dragging, setDragging] = useState<{
    index: number;
    axis: "x" | "y";
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [imgSize, setImgSize] = useState<{
    naturalW: number;
    naturalH: number;
    displayW: number;
    displayH: number;
  } | null>(null);
  /**
   * True when the `guided` paragraph mode is active (00015). In that mode the
   * user clicks between vertical lines to pick which columns merge.
   */
  const [guided, setGuided] = useState(false);
  /** Column tool active: clicking between vertical lines toggles its merge. */
  const [mergeMode, setMergeMode] = useState(false);
  /** 0-based column indices chosen to merge their wrapped lines (00015). */
  const [mergeColumns, setMergeColumns] = useState<number[]>([]);

  const onImageLoad = useCallback(() => {
    const img = imgRef.current;
    const container = containerRef.current;
    if (!img || !container) return;
    const containerRect = container.getBoundingClientRect();
    const maxW = containerRect.width - 32;
    const maxH = containerRect.height - 120;
    const scale = Math.min(
      maxW / img.naturalWidth,
      maxH / img.naturalHeight,
      1,
    );
    setImgSize({
      naturalW: img.naturalWidth,
      naturalH: img.naturalHeight,
      displayW: img.naturalWidth * scale,
      displayH: img.naturalHeight * scale,
    });
  }, []);

  const addLine = useCallback(
    (clientX: number, clientY: number) => {
      if (!imgSize) return;
      const imgEl = imgRef.current;
      if (!imgEl) return;
      const rect = imgEl.getBoundingClientRect();
      // Append to the shared list - lines of the other direction must be
      // kept so vertical + horizontal separators can be combined freely.
      if (mode === "vertical") {
        const pct = ((clientX - rect.left) / imgSize.displayW) * 100;
        setLines((prev) => [
          ...prev,
          { pct: Math.max(0, Math.min(100, pct)), vertical: true },
        ]);
      } else {
        const pct = ((clientY - rect.top) / imgSize.displayH) * 100;
        setLines((prev) => [
          ...prev,
          { pct: Math.max(0, Math.min(100, pct)), vertical: false },
        ]);
      }
    },
    [imgSize, mode],
  );

  const removeLine = useCallback((index: number) => {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }, []);

  /** In guided mode, toggle the merge flag of the column under a click x. */
  const toggleMergeColumn = useCallback(
    (clientX: number) => {
      if (!imgSize) return;
      const imgEl = imgRef.current;
      if (!imgEl) return;
      const rect = imgEl.getBoundingClientRect();
      const xPct = ((clientX - rect.left) / imgSize.displayW) * 100;
      const vertical = lines
        .filter((l) => l.vertical)
        .map((l) => l.pct)
        .sort((a, b) => a - b);
      // Column index = number of vertical lines to the left of the click.
      const col = vertical.filter((v) => v < xPct).length;
      setMergeColumns((prev) =>
        prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col],
      );
    },
    [imgSize, lines],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (loading) return;
      // Check if the click is on a line drag handle (handled by the line's
      // own pointer events). Otherwise add a new line.
      const target = e.target as HTMLElement;
      if (target.closest("[data-line-handle]")) return;
      if (mergeMode) {
        toggleMergeColumn(e.clientX);
        return;
      }
      addLine(e.clientX, e.clientY);
    },
    [loading, mergeMode, toggleMergeColumn, addLine],
  );

  const handleLinePointerDown = useCallback(
    (index: number, e: React.PointerEvent) => {
      if (loading) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const line = lines[index];
      setDragging({
        index,
        axis: line?.vertical ? "x" : "y",
      });
    },
    [loading, lines],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging || !imgSize) return;
      const imgEl = imgRef.current;
      if (!imgEl) return;
      const rect = imgEl.getBoundingClientRect();
      let clamped: number;
      if (dragging.axis === "x") {
        clamped = Math.max(
          0,
          Math.min(100, ((e.clientX - rect.left) / imgSize.displayW) * 100),
        );
      } else {
        clamped = Math.max(
          0,
          Math.min(100, ((e.clientY - rect.top) / imgSize.displayH) * 100),
        );
      }
      setLines((prev) => {
        const next = [...prev];
        next[dragging.index] = { ...next[dragging.index], pct: clamped };
        return next;
      });
    },
    [dragging, imgSize],
  );

  const handlePointerUp = useCallback(() => {
    setDragging(null);
  }, []);

  const handleDblClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const lineIdx = target
        .closest("[data-line-idx]")
        ?.getAttribute("data-line-idx");
      if (lineIdx !== null && lineIdx !== undefined) {
        removeLine(Number(lineIdx));
      }
    },
    [removeLine],
  );

  const horizontalCount = lines.filter((l) => !l.vertical).length;

  // 00015: enable the guided column-merge tool only when the user's paragraph
  // mode is `guided`.
  useEffect(() => {
    let active = true;
    void getAppSettings()
      .then((s) => {
        if (active) setGuided((s?.paragraphMode ?? "smart") === "guided");
      })
      .catch(() => {
        if (active) setGuided(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleConfirm = useCallback(async () => {
    if (lines.length === 0) {
      toast.error(t("imgTable.needLine"));
      return;
    }
    setLoading(true);
    try {
      const result = await ocrImageTable({
        imagePath,
        verticalLines: lines.filter((l) => l.vertical).map((l) => l.pct),
        // Only attach horizontal hints when actually drawn so the backend's
        // legacy auto-row-detection stays untouched otherwise.
        ...(horizontalCount > 0
          ? {
              horizontalLines: lines
                .filter((l) => !l.vertical)
                .map((l) => l.pct),
            }
          : {}),
        // 00015 guided: send the picked merge columns plus the drawn lines so
        // the backend can merge only those columns' wrapped text.
        ...(guided
          ? {
              guided: {
                mergeColumns,
                horizontalLines: lines
                  .filter((l) => !l.vertical)
                  .map((l) => l.pct),
              },
            }
          : {}),
      });
      onResult(result);
      onClose();
      recordUsage({
        kind: "imageTable",
        fileCount: 1,
        pageCount: 1,
        ocrPageCount: 1,
        engine: result.engine,
        totalMs: result.durationMs,
      });
    } catch (e) {
      toast.error(t("imgTable.extractFailed"), { description: String(e) });
    } finally {
      setLoading(false);
    }
  }, [
    lines,
    horizontalCount,
    guided,
    mergeColumns,
    imagePath,
    onResult,
    onClose,
  ]);

  // Keyboard shortcut: Enter to confirm, Esc to cancel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter" && !loading) {
        void handleConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, handleConfirm, loading]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90"
      ref={containerRef}
    >
      {/* Header bar */}
      <div className="flex shrink-0 items-center justify-between px-4 py-2">
        <span className="text-sm text-white/60">
          {t("drawtable.instruction")}
        </span>
        <div className="flex items-center gap-2">
          {/* Line-direction toggle: column separators vs row boundaries.
              Active state uses `secondary` with the theme foreground so the
              icon stays readable in light mode; inactive ghost buttons sit
              on the dark backdrop and need light icons. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={mode === "vertical" ? "secondary" : "ghost"}
                size="icon-sm"
                onClick={() => setMode("vertical")}
                className={cn(
                  mode !== "vertical" && "text-white/70 hover:text-white",
                )}
              >
                <MoveVertical />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("drawtable.verticalMode")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={mode === "horizontal" ? "secondary" : "ghost"}
                size="icon-sm"
                onClick={() => setMode("horizontal")}
                className={cn(
                  mode !== "horizontal" && "text-white/70 hover:text-white",
                )}
              >
                <MoveHorizontal />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("drawtable.horizontalMode")}</TooltipContent>
          </Tooltip>

          {/* Clear every drawn line */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={lines.length === 0 || loading}
                onClick={() => setLines([])}
                className="text-white/70 hover:text-white disabled:text-white/30"
              >
                <Trash2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("drawtable.clearAll")}</TooltipContent>
          </Tooltip>

          {/* 00015 guided: pick which columns merge their wrapped lines. */}
          {guided ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={mergeMode ? "secondary" : "ghost"}
                  size="icon-sm"
                  disabled={
                    loading || lines.filter((l) => l.vertical).length === 0
                  }
                  onClick={() => setMergeMode((v) => !v)}
                  className={cn(!mergeMode && "text-white/70 hover:text-white")}
                >
                  <Columns3 />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("drawtable.mergeColumn")}</TooltipContent>
            </Tooltip>
          ) : null}

          <Button
            variant="secondary"
            size="sm"
            onClick={handleConfirm}
            disabled={loading || lines.length === 0}
          >
            {loading ? <Loader2 className="animate-spin" /> : null}
            {loading ? t("drawtable.extracting") : t("drawtable.extract")}
          </Button>
          <Button
            variant="secondary"
            size="icon-sm"
            onClick={onClose}
            disabled={loading}
          >
            <X />
          </Button>
        </div>
      </div>

      {/* Image area */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {!imgSize && (
          <img
            ref={imgRef}
            src={convertFileSrc(imagePath)}
            alt=""
            className="hidden"
            onLoad={onImageLoad}
          />
        )}
        {imgSize && (
          <div
            className="relative cursor-crosshair"
            style={{ width: imgSize.displayW, height: imgSize.displayH }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onDoubleClick={handleDblClick}
          >
            <img
              ref={imgRef}
              src={convertFileSrc(imagePath)}
              alt=""
              className="pointer-events-none block"
              style={{ width: imgSize.displayW, height: imgSize.displayH }}
              onLoad={onImageLoad}
            />
            <svg
              width={imgSize.displayW}
              height={imgSize.displayH}
              className="pointer-events-none absolute left-0 top-0"
            >
              {/* 00015 guided: highlight the user-picked merge columns. */}
              {guided && mergeMode ? (
                <>
                  {(() => {
                    const boundaries = [0].concat(
                      lines
                        .filter((l) => l.vertical)
                        .map((l) => (l.pct / 100) * imgSize.displayW)
                        .sort((a, b) => a - b),
                      [imgSize.displayW],
                    );
                    return Array.from({ length: boundaries.length - 1 }).map(
                      (_, col) =>
                        mergeColumns.includes(col) ? (
                          <rect
                            key={col}
                            x={boundaries[col]}
                            width={boundaries[col + 1] - boundaries[col]}
                            y={0}
                            height={imgSize.displayH}
                            fill="rgba(34, 197, 94, 0.25)"
                            stroke="rgba(34, 197, 94, 0.7)"
                          />
                        ) : null,
                    );
                  })()}
                </>
              ) : null}
              {lines.map((line, i) => {
                const pos =
                  (line.pct / 100) *
                  (line.vertical ? imgSize.displayW : imgSize.displayH);
                const color = line.vertical ? VERTICAL_COLOR : HORIZONTAL_COLOR;
                const cursor = line.vertical ? "ew-resize" : "ns-resize";
                return (
                  <g
                    key={i}
                    data-line-idx={i}
                    data-line-handle=""
                    className="pointer-events-auto"
                    onPointerDown={(e) => handleLinePointerDown(i, e)}
                  >
                    {line.vertical ? (
                      <>
                        <line
                          x1={pos}
                          y1={0}
                          x2={pos}
                          y2={imgSize.displayH}
                          stroke={color}
                          strokeWidth={2}
                          strokeDasharray="6 3"
                        />
                        <line
                          x1={pos}
                          y1={0}
                          x2={pos}
                          y2={imgSize.displayH}
                          stroke="transparent"
                          strokeWidth={14}
                          style={{ cursor }}
                        />
                        <circle
                          cx={pos}
                          cy={8}
                          r={5}
                          fill={color}
                          style={{ cursor }}
                        />
                      </>
                    ) : (
                      <>
                        <line
                          x1={0}
                          y1={pos}
                          x2={imgSize.displayW}
                          y2={pos}
                          stroke={color}
                          strokeWidth={2}
                          strokeDasharray="6 3"
                        />
                        <line
                          x1={0}
                          y1={pos}
                          x2={imgSize.displayW}
                          y2={pos}
                          stroke="transparent"
                          strokeWidth={14}
                          style={{ cursor }}
                        />
                        <circle
                          cx={imgSize.displayW - 8}
                          cy={pos}
                          r={5}
                          fill={color}
                          style={{ cursor }}
                        />
                      </>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}

export default ImageTableOverlay;
