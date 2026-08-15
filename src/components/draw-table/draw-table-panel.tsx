import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import { toast } from "sonner";

import { CanvasOverlay } from "@/components/draw-table/canvas-overlay";
import { DrawTableToolbar } from "@/components/draw-table/draw-table-toolbar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { extractDrawTableToMarkdown } from "@/lib/ipc";
import type { DrawLine, PageDrawTable } from "@/lib/types";
import { cn } from "@/lib/utils";

interface DrawTablePanelProps {
  /** PDF file path (filesystem path for the IPC calls) */
  pdfPath: string;
  /** PDF file URL usable by pdfjs (already passed through convertFileSrc) */
  path: string;
  /** PDF page number (1-indexed) */
  currentPage: number;
  /** Total pages available for drawing */
  pageCount: number;
  /** Navigate to the previous page */
  onPrevPage: () => void;
  /** Navigate to the next page */
  onNextPage: () => void;
  /** Canvas rendering scale (CSS pixels per PDF point) */
  scale: number;
  /** Page width in CSS pixels */
  canvasWidth: number;
  /** Page height in CSS pixels */
  canvasHeight: number;
  /** Page origin X in PDF points (from pdfjs rawDims.pageX) */
  pageX: number;
  /** Page origin Y in PDF points (from pdfjs rawDims.pageY) */
  pageY: number;
  /** Page width in PDF points (from pdfjs rawDims.pageWidth) */
  pageWidth: number;
  /** Page height in PDF points (from pdfjs rawDims.pageHeight) */
  pageHeight: number;
  /** Called when tables are extracted and ready to merge into Markdown */
  onMergeToMarkdown?: (markdown: string) => void;
  className?: string;
}

interface PageDrawState {
  verticalLines: DrawLine[];
}

type HistoryEntry = PageDrawState;

export function DrawTablePanel({
  pdfPath,
  path,
  currentPage,
  pageCount,
  onPrevPage,
  onNextPage,
  scale,
  canvasWidth,
  canvasHeight,
  pageX,
  pageY,
  pageWidth,
  pageHeight,
  onMergeToMarkdown,
  className,
}: DrawTablePanelProps) {
  const [drawState, setDrawState] = useState<PageDrawState>(() => ({
    verticalLines: [],
  }));

  const pageCanvasRef = useRef<HTMLCanvasElement>(null);

  // Per-page state storage
  const pageStatesRef = useRef<Map<number, PageDrawState>>(new Map());

  // History for undo/redo
  const [history, setHistory] = useState<HistoryEntry[]>([drawState]);
  const [historyIndex, setHistoryIndex] = useState(0);

  const [extracting, setExtracting] = useState(false);

  // Save current page state when page changes
  useEffect(() => {
    pageStatesRef.current.set(currentPage, drawState);
  }, [currentPage, drawState]);

  // Restore page state when page changes
  useEffect(() => {
    const saved = pageStatesRef.current.get(currentPage);
    if (saved) {
      setDrawState(saved);
      // Reset history for the page
      setHistory([saved]);
      setHistoryIndex(0);
    } else {
      const empty: PageDrawState = {
        verticalLines: [],
      };
      setDrawState(empty);
      setHistory([empty]);
      setHistoryIndex(0);
    }
  }, [currentPage]);

  const pushHistory = useCallback(
    (newState: PageDrawState) => {
      const newHistory = history.slice(0, historyIndex + 1);
      newHistory.push(newState);
      if (newHistory.length > 50) newHistory.shift(); // limit history
      setHistory(newHistory);
      setHistoryIndex(newHistory.length - 1);
    },
    [history, historyIndex],
  );

  const hasLines = drawState.verticalLines.length > 0;

  // Render the current page into the overlay's background canvas. The canvas is
  // anchored to the top-left of the same box that hosts CanvasOverlay, so the
  // drawn lines' coordinate mapping (CanvasOverlay) matches the PDF exactly.
  useEffect(() => {
    const canvas = pageCanvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const task = pdfjs.getDocument({ url: path });
    task.promise
      .then((doc) => doc.getPage(currentPage))
      .then(async (page) => {
        if (cancelled) return;
        const viewport = page.getViewport({ scale: scale * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvas, viewport }).promise;
        }
        page.cleanup();
      })
      .catch(() => {})
      .finally(() => task.destroy());

    return () => {
      cancelled = true;
      task.destroy();
    };
  }, [path, currentPage, scale]);

  const handleLineAdd = useCallback(
    (line: DrawLine) => {
      const newState = {
        verticalLines: [...drawState.verticalLines, line],
      };
      setDrawState(newState);
      pushHistory(newState);
    },
    [drawState, pushHistory],
  );

  const handleLineRemove = useCallback(
    (id: string) => {
      const newState = {
        verticalLines: drawState.verticalLines.filter((l) => l.id !== id),
      };
      setDrawState(newState);
      pushHistory(newState);
    },
    [drawState, pushHistory],
  );

  const handleLineUpdate = useCallback(
    (id: string, canvasValue: number, pdfValue: number) => {
      setDrawState((prev) => ({
        ...prev,
        verticalLines: prev.verticalLines.map((l) =>
          l.id === id ? { ...l, canvasValue, pdfValue } : l,
        ),
      }));
    },
    [],
  );

  const handleUndo = useCallback(() => {
    if (historyIndex > 0) {
      const newIdx = historyIndex - 1;
      setHistoryIndex(newIdx);
      setDrawState(history[newIdx]);
    }
  }, [history, historyIndex]);

  const handleRedo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIdx = historyIndex + 1;
      setHistoryIndex(newIdx);
      setDrawState(history[newIdx]);
    }
  }, [history, historyIndex]);

  const handleClear = useCallback(() => {
    const empty: PageDrawState = {
      verticalLines: [],
    };
    setDrawState(empty);
    pushHistory(empty);
  }, [pushHistory]);

  const handleExtract = useCallback(async () => {
    setExtracting(true);

    // Save current page state first
    pageStatesRef.current.set(currentPage, drawState);

    // Build the request from all pages
    const pages: PageDrawTable[] = [];
    for (const [page, state] of pageStatesRef.current) {
      const pageData: PageDrawTable = {
        page,
        horizontalLines: [],
        verticalLines: state.verticalLines.map((l) => l.pdfValue),
        pageX,
        pageY,
        pageWidth,
        pageHeight,
      };
      pages.push(pageData);
    }

    const request = { pages, useForAllPages: true };

    try {
      const md = await extractDrawTableToMarkdown(pdfPath, request);

      if (md.trim()) {
        onMergeToMarkdown?.(md);
        toast.success("提取完成，已合并到 Markdown");
      } else {
        toast.warning("未提取到表格", {
          description: "请调整竖线位置后重试",
        });
      }
    } catch (e) {
      toast.error("提取失败", { description: String(e) });
    } finally {
      setExtracting(false);
    }
  }, [pdfPath, currentPage, drawState, onMergeToMarkdown]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;

      if (e.key === "y" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleRedo();
      } else if (e.key === "z" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleUndo();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (hasLines) handleExtract();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleUndo, handleRedo, handleExtract, hasLines]);

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-2", className)}>
      {/* Toolbar */}
      <DrawTableToolbar
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={historyIndex > 0}
        canRedo={historyIndex < history.length - 1}
        onClear={handleClear}
        onExtract={handleExtract}
        extracting={extracting}
        hasLines={hasLines}
        currentPage={currentPage}
        pageCount={pageCount}
        onPrevPage={onPrevPage}
        onNextPage={onNextPage}
      />

      {/* Canvas area with ScrollArea for vertical scrolling */}
      <ScrollArea className="relative min-h-0 flex-1 rounded-lg border bg-muted/20">
        <div
          className="relative"
          style={{ width: canvasWidth, height: canvasHeight }}
        >
          <canvas
            ref={pageCanvasRef}
            className="absolute left-0 top-0 block dark:invert dark:hue-rotate-180"
            style={{ width: canvasWidth, height: canvasHeight }}
          />
          <CanvasOverlay
            scale={scale}
            verticalLines={drawState.verticalLines}
            onLineAdd={handleLineAdd}
            onLineRemove={handleLineRemove}
            onLineUpdate={handleLineUpdate}
            width={canvasWidth}
            height={canvasHeight}
          />
        </div>
      </ScrollArea>
    </div>
  );
}
