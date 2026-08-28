import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import { toast } from "sonner";

import { CanvasOverlay } from "@/components/draw-table/canvas-overlay";
import { DrawTableToolbar } from "@/components/draw-table/draw-table-toolbar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/i18n";
import { extractDrawTable, getAppSettings } from "@/lib/ipc";
import { engineForMode, recordUsage } from "@/lib/usage";
import type {
  ActivityProgress,
  DrawLine,
  DrawTableRequest,
  DrawTableResult,
  MdTable,
  PageDrawTable,
  PageImagePayload,
  TableRegionInfo,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/** Default render DPI multiplier for OCR page images (~180 DPI). */
const OCR_RENDER_SCALE = 2.5;
/** High-precision render DPI multiplier (~288 DPI). */
const OCR_RENDER_SCALE_HQ = 4.0;
/** Max pages rendered per OCR batch to bound peak IPC payload size. */
const OCR_BATCH_SIZE = 6;

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
  /**
   * Whether any page might need the local PaddleOCR fallback (document is not
   * purely text-based). When omitted, extraction conservatively assumes OCR
   * may be needed - attaching images is harmless for text pages.
   */
  mayNeedOcr?: boolean;
  /** Called when tables are extracted and ready to merge into Markdown. The
   * second argument is the total backend extraction time in milliseconds. */
  onMergeToMarkdown?: (markdown: string, processingTimeMs?: number) => void;
  /**
   * Reports long-running phases (text extraction / OCR recognition) so the
   * status bar can show a progress indicator. `null` means "finished".
   */
  onProgress?: (progress: ActivityProgress | null) => void;
  className?: string;
}

interface PageDrawState {
  verticalLines: DrawLine[];
  horizontalLines: DrawLine[];
}

type HistoryEntry = PageDrawState;

const EMPTY_DRAW_STATE: PageDrawState = {
  verticalLines: [],
  horizontalLines: [],
};

/** Render extracted tables as GFM markdown, prefixed with `<!-- Page N -->` markers. */
function buildTablesMarkdown(
  tables: MdTable[],
  regions: TableRegionInfo[],
): string {
  const chunks: string[] = [];
  let currentPage: number | null = null;
  for (let i = 0; i < tables.length; i++) {
    const table = tables[i];
    if (!table.columns.length) continue;

    let chunk = "";
    const page = regions[i]?.page ?? null;
    if (page !== null && page !== currentPage) {
      currentPage = page;
      chunk += `<!-- Page ${page} -->\n\n`;
    }

    chunk += "|";
    for (const col of table.columns) {
      chunk += ` ${col} |`;
    }
    chunk += `\n|${table.columns.map(() => " --- |").join("")}\n`;
    for (const row of table.rows) {
      chunk += "|";
      for (const cell of row) {
        chunk += ` ${cell} |`;
      }
      chunk += "\n";
    }
    chunks.push(chunk);
  }
  return chunks.join("\n\n---\n\n");
}

/** Merge two draw-table extraction results (batched OCR runs). */
function mergeDrawResults(
  a: DrawTableResult,
  b: DrawTableResult,
): DrawTableResult {
  return {
    tableCount: a.tableCount + b.tableCount,
    tables: [...a.tables, ...b.tables],
    regions: [...a.regions, ...b.regions],
    totalRows: a.totalRows + b.totalRows,
    processingTimeMs: a.processingTimeMs + b.processingTimeMs,
    ocrPages: [...a.ocrPages, ...b.ocrPages],
    emptyTextPages: Array.from(
      new Set([...a.emptyTextPages, ...b.emptyTextPages]),
    ),
  };
}

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
  mayNeedOcr,
  onMergeToMarkdown,
  onProgress,
  className,
}: DrawTablePanelProps) {
  const { t } = useI18n();
  const [drawState, setDrawState] = useState<PageDrawState>(() => ({
    ...EMPTY_DRAW_STATE,
  }));
  /** Which direction a click on the canvas creates. */
  const [mode, setMode] = useState<"vertical" | "horizontal">("vertical");

  const pageCanvasRef = useRef<HTMLCanvasElement>(null);
  // Cache the loaded PDF document so page switches reuse the parsed doc
  // instead of re-downloading/re-parsing the whole file every time.
  const docRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  // In-flight document load, shared by the preview canvas and OCR rendering.
  const docPromiseRef = useRef<Promise<pdfjs.PDFDocumentProxy> | null>(null);
  const loadingTaskRef = useRef<pdfjs.PDFDocumentLoadingTask | null>(null);
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null);

  /** Load (or reuse) the parsed PDF document shared by preview and OCR renders. */
  const getDoc = useCallback((): Promise<pdfjs.PDFDocumentProxy> => {
    if (docRef.current) return Promise.resolve(docRef.current);
    if (!docPromiseRef.current) {
      const task = pdfjs.getDocument({ url: path });
      loadingTaskRef.current = task;
      docPromiseRef.current = task.promise.then((doc) => {
        docRef.current = doc;
        return doc;
      });
    }
    return docPromiseRef.current;
  }, [path]);

  /**
   * Render pages to PNG base64 at OCR resolution for the local PaddleOCR
   * fallback. Each canvas is released as soon as its payload is captured.
   */
  const renderPageImages = useCallback(
    async (
      pages: number[],
      renderScale: number,
    ): Promise<PageImagePayload[]> => {
      const doc = await getDoc();
      const out: PageImagePayload[] = [];
      for (const pageNum of pages) {
        const page = await doc.getPage(pageNum);
        try {
          const viewport = page.getViewport({ scale: renderScale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvas, viewport }).promise;
          const dataUrl = canvas.toDataURL("image/png");
          const comma = dataUrl.indexOf(",");
          out.push({
            page: pageNum,
            imagePng: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
            renderScale,
          });
          canvas.width = 0;
        } finally {
          page.cleanup();
        }
      }
      return out;
    },
    [getDoc],
  );

  // Per-page state storage
  const pageStatesRef = useRef<Map<number, PageDrawState>>(new Map());

  // History for undo/redo
  const [history, setHistory] = useState<HistoryEntry[]>([drawState]);
  const [historyIndex, setHistoryIndex] = useState(0);

  const [extracting, setExtracting] = useState<"all" | "first5" | null>(null);

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
      setDrawState({ ...EMPTY_DRAW_STATE });
      setHistory([{ ...EMPTY_DRAW_STATE }]);
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

  const hasLines =
    drawState.verticalLines.length > 0 || drawState.horizontalLines.length > 0;

  // Render the current page into the overlay's background canvas. The canvas is
  // anchored to the top-left of the same box that hosts CanvasOverlay, so the
  // drawn lines' coordinate mapping (CanvasOverlay) matches the PDF exactly.
  // The parsed document is cached (docRef) so navigating pages is fast even for
  // large PDFs; only the first render pays the parse cost.
  useEffect(() => {
    const canvas = pageCanvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    (async () => {
      try {
        const doc = await getDoc();
        if (cancelled) return;

        const page = await doc.getPage(currentPage);
        if (cancelled) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        const viewport = page.getViewport({ scale: scale * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          renderTaskRef.current?.cancel();
          renderTaskRef.current = page.render({ canvas, viewport });
          await renderTaskRef.current.promise;
        }
        page.cleanup();
      } catch {
        // Ignore render errors (e.g. task cancelled while switching pages).
      }
    })();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [path, currentPage, scale, getDoc]);

  // Release the cached document when the PDF path changes or on unmount.
  useEffect(() => {
    return () => {
      renderTaskRef.current?.cancel();
      loadingTaskRef.current?.destroy();
      loadingTaskRef.current = null;
      docRef.current = null;
      docPromiseRef.current = null;
    };
  }, [path]);

  const handleLineAdd = useCallback(
    (line: DrawLine) => {
      const newState =
        line.type === "vertical"
          ? { ...drawState, verticalLines: [...drawState.verticalLines, line] }
          : {
              ...drawState,
              horizontalLines: [...drawState.horizontalLines, line],
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
        horizontalLines: drawState.horizontalLines.filter((l) => l.id !== id),
      };
      setDrawState(newState);
      pushHistory(newState);
    },
    [drawState, pushHistory],
  );

  const handleLineUpdate = useCallback(
    (id: string, canvasValue: number, pdfValue: number) => {
      setDrawState((prev) => ({
        verticalLines: prev.verticalLines.map((l) =>
          l.id === id ? { ...l, canvasValue, pdfValue } : l,
        ),
        horizontalLines: prev.horizontalLines.map((l) =>
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
    setDrawState({ ...EMPTY_DRAW_STATE });
    pushHistory({ ...EMPTY_DRAW_STATE });
  }, [pushHistory]);

  /**
   * Extraction with local PaddleOCR fallback: pages without a text layer are
   * rendered to PNG and recognized on-device. Small ranges attach all images
   * in one call; larger ranges first resolve text-layer pages cheaply, then
   * OCR only the empty ones in bounded batches.
   */
  const extractWithOcr = useCallback(
    async (
      request: DrawTableRequest,
      renderScale: number,
    ): Promise<DrawTableResult> => {
      const doc = await getDoc();
      request.totalPages = doc.numPages;

      const rangeEnd =
        request.useForAllPages && request.maxPages
          ? Math.min(request.maxPages, doc.numPages)
          : doc.numPages;
      const targetPages: number[] = [];
      if (request.useForAllPages) {
        for (let p = 1; p <= rangeEnd; p++) targetPages.push(p);
      } else {
        for (const p of request.pages) {
          if (!targetPages.includes(p.page)) targetPages.push(p.page);
        }
      }

      if (targetPages.length <= OCR_BATCH_SIZE) {
        onProgress?.({ phase: "ocr", total: targetPages.length });
        const images = await renderPageImages(targetPages, renderScale);
        return extractDrawTable(pdfPath, { ...request, pageImages: images });
      }

      // Phase 1 over the whole range without images: text-layer pages are
      // extracted instantly from the backend cache; only pages that came up
      // empty go through rendering + OCR.
      onProgress?.({ phase: "extract" });
      let result = await extractDrawTable(pdfPath, request);
      const ocrNeeded = result.emptyTextPages.filter((p) =>
        targetPages.includes(p),
      );
      for (let i = 0; i < ocrNeeded.length; i += OCR_BATCH_SIZE) {
        const batch = ocrNeeded.slice(i, i + OCR_BATCH_SIZE);
        onProgress?.({
          phase: "ocr",
          current: Math.min(i + OCR_BATCH_SIZE, ocrNeeded.length),
          total: ocrNeeded.length,
        });
        const images = await renderPageImages(batch, renderScale);
        const batchResult = await extractDrawTable(pdfPath, {
          ...request,
          onlyPages: batch,
          pageImages: images,
        });
        result = mergeDrawResults(result, batchResult);
      }
      return result;
    },
    [getDoc, renderPageImages, pdfPath, onProgress],
  );

  const handleExtract = useCallback(
    async (maxPages?: number) => {
      setExtracting(maxPages ? "first5" : "all");

      // Save current page state first
      pageStatesRef.current.set(currentPage, drawState);

      // Build the request from all pages
      const pages: PageDrawTable[] = [];
      for (const [page, state] of pageStatesRef.current) {
        const pageData: PageDrawTable = {
          page,
          horizontalLines: state.horizontalLines.map((l) => l.pdfValue),
          verticalLines: state.verticalLines.map((l) => l.pdfValue),
          pageX,
          pageY,
          pageWidth,
          pageHeight,
        };
        pages.push(pageData);
      }

      const request: DrawTableRequest = {
        pages,
        useForAllPages: true,
        ...(maxPages ? { maxPages } : {}),
      };

      try {
        // The draw-table OCR fallback follows the selected OCR mode: local
        // PaddleOCR (forceLocal/nonTextLocal) or remote AI vision
        // (forceAi/nonTextAi) are resolved on the backend; disabled keeps
        // extraction text-layer-only.
        const settings = await getAppSettings();
        const useOcr = settings.ocrMode !== "disabled" && (mayNeedOcr ?? true);
        // High-precision mode renders OCR page images at a higher DPI; the
        // backend pairs this with width-weighted character cutting.
        const renderScale = settings.drawTableHighPrecision
          ? OCR_RENDER_SCALE_HQ
          : OCR_RENDER_SCALE;
        const result = useOcr
          ? await extractWithOcr(request, renderScale)
          : await extractDrawTable(pdfPath, request);

        const ocrEngine = engineForMode(settings.ocrMode);
        const pageCount = new Set(result.regions.map((r) => r.page)).size;
        recordUsage({
          kind: "drawTable",
          fileCount: 1,
          pageCount,
          ocrPageCount: result.ocrPages.length,
          engine: ocrEngine,
          totalMs: result.processingTimeMs,
        });

        const md =
          result.tableCount > 0
            ? buildTablesMarkdown(result.tables, result.regions)
            : "";

        if (md.trim()) {
          onMergeToMarkdown?.(md, result.processingTimeMs);
          if (result.ocrPages.length > 0) {
            toast.success(
              t("toast.extractDoneOcr", { count: result.ocrPages.length }),
            );
          } else {
            toast.success(t("toast.extractDone"));
          }
        } else {
          toast.warning(t("toast.noTable"), {
            description: t("toast.noTableDesc"),
          });
        }
      } catch (e) {
        toast.error(t("toast.extractFailed"), { description: String(e) });
      } finally {
        setExtracting(null);
        onProgress?.(null);
      }
    },
    [
      pdfPath,
      currentPage,
      drawState,
      mayNeedOcr,
      onMergeToMarkdown,
      extractWithOcr,
      onProgress,
      t,
    ],
  );

  const handleExtractFirst5 = useCallback(() => {
    handleExtract(5);
  }, [handleExtract]);

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
    <div className={cn("flex min-h-0 flex-1 flex-col gap-1", className)}>
      {/* Toolbar */}
      <DrawTableToolbar
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={historyIndex > 0}
        canRedo={historyIndex < history.length - 1}
        onClear={handleClear}
        mode={mode}
        onModeChange={setMode}
        onExtract={handleExtract}
        onExtractFirst5={handleExtractFirst5}
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
            mode={mode}
            verticalLines={drawState.verticalLines}
            horizontalLines={drawState.horizontalLines}
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
