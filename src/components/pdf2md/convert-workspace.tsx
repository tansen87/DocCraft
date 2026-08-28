import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { toast } from "sonner";

import { ConvertToolbar } from "./convert-toolbar";
import { PdfPreview } from "./pdf-preview";
import { PreviewPane } from "./preview-pane";
import { convertWithOcr } from "./render-pdf-pages";
import { StatusBar } from "./status-bar";
import { DrawTablePanel } from "@/components/draw-table/draw-table-panel";
import { useI18n } from "@/i18n";
import { Link2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  convertPdf,
  detectPdf,
  exportMarkdown,
  getAppSettings,
  revealExport,
} from "@/lib/ipc";
import type {
  ActivityProgress,
  ConvertResult,
  DetectResult,
  StatusNotice,
} from "@/lib/types";
import * as pdfjs from "pdfjs-dist";
import { GlassPanel } from "@/components/ui/glass-panel";

interface ConvertWorkspaceProps {
  filePath: string;
  fileName: string;
  /** Provide a finished conversion to open it directly (e.g. preview a batch item). */
  initialResult?: ConvertResult | null;
  /**
   * Called after a successful (re)conversion within this workspace.
   * Lets a parent keep its own file list in sync.
   */
  onConverted?: (result: ConvertResult) => void;
  /** Remove / clear the current file. */
  onClear?: () => void;
}

/**
 * Parse a page-range spec (`"1-5,8,12-14"`) into the set of 1-indexed pages it
 * selects, clamped to `[1, pageCount]`. Returns `null` when the spec is blank
 * or selects nothing, meaning "convert the whole document".
 */
function parsePageRange(spec: string, pageCount: number): number[] | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;
  if (!Number.isFinite(pageCount) || pageCount <= 0) return null;
  const pages = new Set<number>();
  for (const rawToken of trimmed.split(",")) {
    const token = rawToken.trim();
    if (!token) continue;
    const dashIdx = token.indexOf("-");
    if (dashIdx >= 0) {
      const a = Number(token.slice(0, dashIdx).trim());
      const b = Number(token.slice(dashIdx + 1).trim());
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let p = lo; p <= Math.min(hi, pageCount); p += 1) {
        if (p >= 1) pages.add(p);
      }
    } else {
      const p = Number(token);
      if (Number.isInteger(p) && p >= 1 && p <= pageCount) pages.add(p);
    }
  }
  if (pages.size === 0) return null;
  return [...pages].sort((a, b) => a - b);
}

export function ConvertWorkspace({
  filePath,
  fileName,
  initialResult,
  onConverted,
  onClear,
}: ConvertWorkspaceProps) {
  const { t } = useI18n();
  const [detecting, setDetecting] = useState(false);
  const [converting, setConverting] = useState(false);
  const [detect, setDetect] = useState<DetectResult | null>(
    initialResult ?? null,
  );
  const [result, setResult] = useState<ConvertResult | null>(
    initialResult ?? null,
  );
  const [drawMode, setDrawMode] = useState(false);
  const [mergedMarkdown, setMergedMarkdown] = useState<string | null>(null);
  /** Page-range spec (`"1-5,8,12-14"`); empty converts all pages. */
  const [pageRange, setPageRange] = useState("");
  /** Elapsed time (ms) of the last draw-table extraction, shown in the preview header. */
  const [extractTimeMs, setExtractTimeMs] = useState(0);
  const [pageSize, setPageSize] = useState<{
    pageWidth: number;
    pageHeight: number;
    canvasWidth: number;
    canvasHeight: number;
    scale: number;
    pageX: number;
    pageY: number;
  } | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  /** In-flight phase shown in the status bar (extraction / OCR progress). */
  const [activity, setActivity] = useState<ActivityProgress | null>(null);
  /** Page jump request for the PDF preview (status bar notice chips). */
  const [jumpPage, setJumpPage] = useState<{
    page: number;
    seq: number;
  } | null>(null);
  const jumpSeqRef = useRef(0);
  /** Page-link mode: clicking a page on either side jumps the other pane. */
  const [syncEnabled, setSyncEnabled] = useState(false);
  /** Page jump request for the Markdown preview (PDF page clicked back). */
  const [markdownJumpPage, setMarkdownJumpPage] = useState<{
    page: number;
    seq: number;
  } | null>(null);
  const markdownJumpSeqRef = useRef(0);

  const containerRef = useRef<HTMLDivElement>(null);

  const busy = detecting || converting;

  // Load page dimensions when entering draw mode.
  // The page is rendered full-bleed inside DrawTablePanel at exactly this size
  // and anchored to the top-left of its canvas area, so the overlay's coordinate
  // space matches the rendered page pixel-for-pixel. Rendering the generic
  // PdfPreview here would misalign the overlay because it adds its own header
  // bar, padding and scrollbar.
  useEffect(() => {
    if (!drawMode) return;

    const container = containerRef.current;
    if (!container) return;

    const task = pdfjs.getDocument({ url: convertFileSrc(filePath) });
    task.promise
      .then((doc) =>
        doc.getPage(1).then((page) => {
          const viewport = page.getViewport({ scale: 1 });
          // Use rawDims for PDF-point dimensions (without userUnit scaling).
          // viewport.width/height include userUnit, which would cause the
          // coordinate conversion to produce userUnit-scaled values that
          // don't match the backend's PDF-point coordinates.
          const rawDims = viewport.rawDims as {
            pageWidth: number;
            pageHeight: number;
            pageX: number;
            pageY: number;
          };
          const pdfWidth = rawDims.pageWidth;
          const pdfHeight = rawDims.pageHeight;
          const pageX = rawDims.pageX;
          const pageY = rawDims.pageY;
          const rect = container.getBoundingClientRect();
          const availableWidth = Math.max(rect.width, 100);
          // Fill width only - the container will scroll vertically if the
          // page is taller than the viewport. This avoids the "smaller PDF"
          // effect caused by constraining scale with Math.min against height,
          // and ensures the overlay coordinate system (CSS pixels per PDF
          // point) matches the rendered PDF exactly.
          const scale = availableWidth / pdfWidth;
          const canvasWidth = pdfWidth * scale;
          const canvasHeight = pdfHeight * scale;

          setPageSize({
            pageWidth: pdfWidth,
            pageHeight: pdfHeight,
            canvasWidth,
            canvasHeight,
            scale,
            pageX,
            pageY,
          });
          page.cleanup();
        }),
      )
      .catch(() => {
        // Fallback to default page size
        const fallbackWidth = Math.max(container.clientWidth, 100);
        setPageSize({
          pageWidth: 595.0,
          pageHeight: 842.0,
          canvasWidth: fallbackWidth,
          canvasHeight: fallbackWidth * (842.0 / 595.0),
          scale: fallbackWidth / 595.0,
          pageX: 0,
          pageY: 0,
        });
      });

    return () => {
      task.destroy();
    };
  }, [drawMode, filePath]);

  useEffect(() => {
    if (initialResult) {
      setDetect(initialResult);
      setResult(initialResult);
      return;
    }
    let cancelled = false;
    setDetecting(true);
    detectPdf(filePath)
      .then((d) => {
        if (!cancelled) setDetect(d);
      })
      .catch((e) =>
        toast.error(t("toast.detectFailed"), { description: String(e) }),
      )
      .finally(() => {
        if (!cancelled) setDetecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, initialResult]);

  const handleConvert = useCallback(async () => {
    if (!filePath) return;
    setConverting(true);
    try {
      // A page range restarts conversion for only the selected pages. Empty
      // range (null) keeps the current whole-document behaviour.
      const range = parsePageRange(pageRange, detect?.pageCount ?? 0);
      const inRange = range ? new Set<number>(range) : null;
      const needOcr = inRange
        ? (detect?.pagesNeedingOcr ?? []).filter((p) => inRange.has(p))
        : (detect?.pagesNeedingOcr ?? []);
      const settings = await getAppSettings();
      const isForce =
        settings.ocrMode === "forceLocal" || settings.ocrMode === "forceAi";
      const ocrPages = range
        ? isForce
          ? range
          : needOcr
        : isForce && detect
          ? Array.from({ length: detect.pageCount }, (_, i) => i + 1)
          : needOcr;
      const rangeSpec = range ? pageRange : undefined;
      const r =
        settings.ocrMode !== "disabled"
          ? await convertWithOcr(
              filePath,
              ocrPages,
              setActivity,
              undefined,
              rangeSpec,
            )
          : await convertPdf(filePath, rangeSpec);
      setResult(r);
      setDetect(r);
      onConverted?.(r);
      toast.success(t("toast.convertDone"));
    } catch (e) {
      toast.error(t("toast.convertFailed"), { description: String(e) });
    } finally {
      setConverting(false);
      setActivity(null);
    }
  }, [filePath, detect, pageRange, onConverted, t]);

  const handleConvertRef = useRef(handleConvert);
  handleConvertRef.current = handleConvert;

  async function handleExport(): Promise<void> {
    const content = result?.markdown ?? mergedMarkdown;
    if (!content) return;
    const base = fileName.replace(/\.pdf$/i, "") || "document";
    const target = await save({
      defaultPath: `${base}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (typeof target !== "string") return;
    try {
      await exportMarkdown(target, content);
      toast.success(t("toast.exported"), {
        description: target,
        action: {
          label: t("action.openFolder"),
          onClick: () => void revealExport(target),
        },
      });
    } catch (e) {
      toast.error(t("toast.exportFailed"), { description: String(e) });
    }
  }

  const toggleDrawMode = useCallback(() => {
    setDrawMode((prev) => !prev);
    if (!drawMode) {
      // Reset when entering draw mode
      setMergedMarkdown(null);
      setExtractTimeMs(0);
    }
  }, [drawMode]);

  const handleMergeToMarkdown = useCallback(
    (markdown: string, processingTimeMs?: number) => {
      setMergedMarkdown(markdown);
      setExtractTimeMs(processingTimeMs ?? 0);
      // If we already have a converted result, merge the table markdown into it
      if (result) {
        const merged =
          result.markdown +
          "\n\n---\n\n" +
          t("markdown.drawTableComment") +
          "\n\n" +
          markdown;
        setResult({ ...result, markdown: merged });
        toast.success(t("toast.mergedToMarkdown"));
      } else {
        // Create a synthetic ConvertResult with just the table markdown
        setMergedMarkdown(markdown);
        toast.success(t("toast.tableExtracted"));
      }
    },
    [result, t],
  );

  const jumpToPage = useCallback((page: number) => {
    jumpSeqRef.current += 1;
    setJumpPage({ page, seq: jumpSeqRef.current });
  }, []);

  const jumpMarkdown = useCallback((page: number) => {
    markdownJumpSeqRef.current += 1;
    setMarkdownJumpPage({ page, seq: markdownJumpSeqRef.current });
  }, []);

  // Structured notices for the status bar bell. Ids are stable so read /
  // dismissed tracking survives re-renders.
  const notices = useMemo<StatusNotice[]>(() => {
    const list: StatusNotice[] = [];
    const failed = drawMode ? [] : (result?.failedPages ?? []);
    if (failed.length > 0) {
      list.push({
        id: "pages-failed",
        level: "error",
        text: t("notice.failedPages", { count: failed.length }),
        pages: failed,
        onPageClick: jumpToPage,
        actions: [
          {
            label: t("status.actionRetry"),
            onClick: () => void handleConvertRef.current(),
          },
        ],
      });
    }
    const skipped = drawMode ? [] : (result?.skippedPages ?? []);
    if (skipped.length > 0) {
      list.push({
        id: "pages-skipped",
        level: "warning",
        text: t("notice.skippedPages", { count: skipped.length }),
        pages: skipped,
        onPageClick: jumpToPage,
      });
    }
    // Draw mode: pages without a text layer will go through the OCR fallback
    // (local PaddleOCR or AI vision, depending on the selected mode).
    if (
      detect &&
      detect.pdfType !== "TextBased" &&
      detect.pagesNeedingOcr.length > 0 &&
      (drawMode || !result)
    ) {
      list.push({
        id: "pages-ocr-fallback",
        level: "info",
        text: t("notice.ocrFallbackPages", {
          count: detect.pagesNeedingOcr.length,
        }),
        pages: detect.pagesNeedingOcr,
        onPageClick: drawMode ? undefined : jumpToPage,
      });
    }
    return list;
  }, [result, detect, drawMode, t, jumpToPage]);

  return (
    <>
      <ConvertToolbar
        name={fileName}
        path={filePath}
        busy={busy}
        converting={converting}
        drawMode={drawMode}
        pageRange={pageRange}
        onPageRangeChange={setPageRange}
        pageCount={detect?.pageCount ?? 0}
        onToggleDrawMode={toggleDrawMode}
        onConvert={handleConvert}
        onClear={onClear}
      />

      {drawMode ? (
        /* Draw Table Mode: full-width canvas overlay */
        <div className="flex min-h-0 flex-1 flex-col gap-1">
          <GlassPanel
            ref={containerRef}
            className="relative min-h-0 flex-1 overflow-hidden rounded-xl"
          >
            {pageSize && (
              <div
                className="absolute inset-0"
                style={{ pointerEvents: "auto" }}
              >
                <DrawTablePanel
                  pdfPath={filePath}
                  path={convertFileSrc(filePath)}
                  currentPage={currentPage}
                  pageCount={Math.min(detect?.pageCount ?? 5, 5)}
                  onPrevPage={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  onNextPage={() => setCurrentPage((p) => p + 1)}
                  scale={pageSize.scale}
                  canvasWidth={pageSize.canvasWidth}
                  canvasHeight={pageSize.canvasHeight}
                  pageX={pageSize.pageX}
                  pageY={pageSize.pageY}
                  pageWidth={pageSize.pageWidth}
                  pageHeight={pageSize.pageHeight}
                  mayNeedOcr={
                    detect
                      ? detect.pdfType !== "TextBased" ||
                        detect.pagesNeedingOcr.length > 0
                      : undefined
                  }
                  onMergeToMarkdown={handleMergeToMarkdown}
                  onProgress={setActivity}
                  className="h-full"
                />
              </div>
            )}
          </GlassPanel>

          {mergedMarkdown ? (
            <div className="shrink-0 max-h-[40vh]">
              <PreviewPane
                markdown={mergedMarkdown}
                processingTimeMs={extractTimeMs}
                onExport={handleExport}
                className="h-full"
                showPageMarkers
              />
            </div>
          ) : null}
        </div>
      ) : (
        /* Normal Mode: PDF preview + Markdown preview */
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-1 lg:grid-cols-2">
          <PdfPreview
            path={filePath}
            className="min-h-[280px]"
            scrollToPage={jumpPage}
            onPageSelect={syncEnabled ? jumpMarkdown : undefined}
          />

          <div className="min-h-0 min-w-0">
            {result ? (
              <PreviewPane
                markdown={result.markdown}
                processingTimeMs={result.processingTimeMs}
                onExport={handleExport}
                className="h-full"
                showPageMarkers
                scrollToPage={syncEnabled ? markdownJumpPage : null}
                onPageSelect={syncEnabled ? jumpToPage : undefined}
                toolbar={
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setSyncEnabled((v) => !v)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                          syncEnabled
                            ? "bg-primary/15 text-primary"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        <Link2 className="size-3.5" />
                        {t("preview.sync")}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t("preview.syncHint")}</TooltipContent>
                  </Tooltip>
                }
              />
            ) : null}
          </div>
        </div>
      )}

      <div className="-mb-3">
        <StatusBar
          result={detect}
          loading={detecting}
          extra={drawMode ? t("mode.drawTable") : undefined}
          notices={notices}
          progress={activity}
        />
      </div>
    </>
  );
}
