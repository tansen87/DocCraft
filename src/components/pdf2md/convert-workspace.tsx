import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { toast } from "sonner";

import { ConvertToolbar } from "./convert-toolbar";
import { ExcludeOverlay } from "./exclude-overlay";
import { ExcludePanel } from "./exclude-panel";
import { PdfPreview } from "./pdf-preview";
import { PreviewPane } from "./preview-pane";
import { convertWithOcr } from "./render-pdf-pages";
import { StatusBar } from "./status-bar";
import { DrawTablePanel } from "@/components/draw-table/draw-table-panel";
import { useI18n } from "@/i18n";
import { Link2 } from "lucide-react";
import { countRects, withPageRects } from "@/lib/exclude-region";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { engineForMode, recordUsage } from "@/lib/usage";
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
  ExcludeRect,
  ExcludeRegions,
  PageExclude,
  PageGeometry,
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
  /**
   * Exclusion-region editor. Rects are kept per page in PDF points; the
   * "apply to all pages" flag makes the first page carrying rects the template
   * for the whole document (see docs/design/00010_pdf-exclude-region.md).
   */
  const [excludeMode, setExcludeMode] = useState(false);
  const [excludePages, setExcludePages] = useState<PageExclude[]>([]);
  const [useForAllPages, setUseForAllPages] = useState(false);
  /** Per-page geometry (pdfjs rawDims) captured when exclusion mode is entered. */
  const [pageGeom, setPageGeom] = useState<Record<number, PageGeometry> | null>(
    null,
  );
  const [mergedMarkdown, setMergedMarkdown] = useState<string | null>(null);
  /** Page-range spec (`"1-5,8,12-14"`); empty converts all pages. */
  const [pageRange, setPageRange] = useState("");
  /** Elapsed time (ms) of the last draw-table extraction, shown in the preview header. */
  const [extractTimeMs, setExtractTimeMs] = useState(0);
  /** Average local-OCR confidence of the last draw-table extraction (0..1). */
  const [drawOcrConfidence, setDrawOcrConfidence] = useState<number | null>(
    null,
  );
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

  // Exclusion regions belong to one document: drop them when the file changes.
  useEffect(() => {
    setExcludePages([]);
    setPageGeom(null);
  }, [filePath]);

  // Load the geometry of every page so rects can be stored in PDF points and
  // clamped correctly when they are applied to pages of a different size.
  useEffect(() => {
    if (!excludeMode) return;
    let cancelled = false;
    const task = pdfjs.getDocument({ url: convertFileSrc(filePath) });
    task.promise
      .then(async (doc) => {
        const geom: Record<number, PageGeometry> = {};
        for (let i = 1; i <= doc.numPages; i += 1) {
          if (cancelled) return;
          const page = await doc.getPage(i);
          // rawDims excludes userUnit scaling, matching the backend's
          // PDF-point coordinate space.
          const rawDims = page.getViewport({ scale: 1 }).rawDims as {
            pageWidth: number;
            pageHeight: number;
            pageX: number;
            pageY: number;
          };
          geom[i] = {
            pageWidth: rawDims.pageWidth,
            pageHeight: rawDims.pageHeight,
            pageX: rawDims.pageX,
            pageY: rawDims.pageY,
            rotation: page.rotate ?? 0,
          };
          page.cleanup();
        }
        if (!cancelled) setPageGeom(geom);
      })
      .catch(() => {
        if (!cancelled) setPageGeom({});
      });
    return () => {
      cancelled = true;
      task.destroy();
    };
  }, [excludeMode, filePath]);

  const updatePageRects = useCallback(
    (page: number, rects: ExcludeRect[]) => {
      const geom = pageGeom?.[page];
      if (!geom) return;
      setExcludePages(
        (prev) =>
          withPageRects(
            { pages: prev },
            {
              page,
              rects,
              pageX: geom.pageX,
              pageY: geom.pageY,
              pageWidth: geom.pageWidth,
              pageHeight: geom.pageHeight,
            },
          ).pages,
      );
    },
    [pageGeom],
  );

  /** Payload sent with the conversion commands; `null` when nothing is drawn. */
  const exclusionSpec = useMemo<ExcludeRegions | null>(() => {
    if (excludePages.length === 0) return null;
    const pages = excludePages
      .filter((p) => p.rects.length > 0)
      .map((p) => ({ ...p, rects: [...p.rects] }))
      .sort((a, b) => a.page - b.page);
    if (pages.length === 0) return null;
    if (useForAllPages && pageGeom) {
      // Rotated pages opt out with an explicit empty entry: their viewport
      // does not match PDF user space, so template rects cannot be mapped.
      for (const [key, geom] of Object.entries(pageGeom)) {
        const page = Number(key);
        if (geom.rotation % 360 === 0) continue;
        if (pages.some((p) => p.page === page)) continue;
        pages.push({
          page,
          rects: [],
          pageX: geom.pageX,
          pageY: geom.pageY,
          pageWidth: geom.pageWidth,
          pageHeight: geom.pageHeight,
        });
      }
    }
    return {
      pages,
      useForAllPages,
      totalPages: detect?.pageCount ?? Object.keys(pageGeom ?? {}).length,
    };
  }, [excludePages, useForAllPages, pageGeom, detect?.pageCount]);

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
              exclusionSpec,
            )
          : await convertPdf(filePath, rangeSpec, exclusionSpec);
      setResult(r);
      setDetect(r);
      onConverted?.(r);
      const engine = engineForMode(settings.ocrMode);
      recordUsage({
        kind: "pdf",
        fileCount: 1,
        pageCount: range ? range.length : r.pageCount,
        ocrPageCount: engine ? ocrPages.length : 0,
        engine,
        totalMs: r.processingTimeMs,
      });
      toast.success(t("toast.convertDone"));
    } catch (e) {
      toast.error(t("toast.convertFailed"), { description: String(e) });
    } finally {
      setConverting(false);
      setActivity(null);
    }
  }, [filePath, detect, pageRange, exclusionSpec, onConverted, t]);

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

  /**
   * The two editors are not exclusive: in draw mode the draw-table surface
   * owns a tri-state tool (vertical / horizontal / exclude) that hands the
   * pointer to whichever overlay is active, so lines and exclusion rects can
   * be placed in any order while the editor stays open.
   */
  const toggleExcludeMode = useCallback(() => {
    setExcludeMode((prev) => !prev);
  }, []);

  const clearExclusions = useCallback(() => {
    setExcludePages([]);
    setUseForAllPages(false);
  }, []);

  /**
   * Exclusion editor layer for one page. Shared by the normal PDF preview and
   * the draw-table surface, which both lay the page out at the same scale, so
   * the same viewport-relative rects line up on either.
   */
  const renderExcludeOverlay = useCallback(
    (page: number) => {
      const geom = pageGeom?.[page];
      if (!geom) return null;
      return (
        <ExcludeOverlay
          page={page}
          pageWidth={geom.pageWidth}
          pageHeight={geom.pageHeight}
          disabled={geom.rotation % 360 !== 0}
          rects={excludePages.find((p) => p.page === page)?.rects ?? []}
          onChange={(next) => updatePageRects(page, next)}
        />
      );
    },
    [pageGeom, excludePages, updatePageRects],
  );

  /** Floating inspector, rendered next to whichever surface is active. */
  const excludePanelNode = excludeMode ? (
    <ExcludePanel
      pages={excludePages}
      loading={!pageGeom}
      useForAllPages={useForAllPages}
      onUseForAllPagesChange={setUseForAllPages}
      onClear={clearExclusions}
      onRemove={(page, index) => {
        const current = excludePages.find((p) => p.page === page)?.rects ?? [];
        updatePageRects(
          page,
          current.filter((_, i) => i !== index),
        );
      }}
    />
  ) : null;

  // Esc leaves the exclusion editor.
  useEffect(() => {
    if (!excludeMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExcludeMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [excludeMode]);

  const handleMergeToMarkdown = useCallback(
    (
      markdown: string,
      processingTimeMs?: number,
      ocrConfidence?: number | null,
    ) => {
      setMergedMarkdown(markdown);
      setExtractTimeMs(processingTimeMs ?? 0);
      setDrawOcrConfidence(ocrConfidence ?? null);
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
    // Local OCR with a low average confidence: flag the whole conversion so
    // the user knows the recognized text may need review.
    if (
      !drawMode &&
      result?.ocrConfidence != null &&
      result.ocrConfidence < 0.7
    ) {
      list.push({
        id: "ocr-low-confidence",
        level: result.ocrConfidence < 0.5 ? "error" : "warning",
        text: t("notice.ocrLowConfidence", {
          pct: Math.round(result.ocrConfidence * 100),
        }),
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
        excludeMode={excludeMode}
        excludeCount={countRects(exclusionSpec)}
        pageRange={pageRange}
        onPageRangeChange={setPageRange}
        pageCount={detect?.pageCount ?? 0}
        onToggleDrawMode={toggleDrawMode}
        onToggleExcludeMode={toggleExcludeMode}
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
                  exclusions={exclusionSpec}
                  renderPageOverlay={
                    excludeMode ? renderExcludeOverlay : undefined
                  }
                  exclusionEditorOpen={excludeMode}
                  onOpenExclusionEditor={() => setExcludeMode(true)}
                  onMergeToMarkdown={handleMergeToMarkdown}
                  onProgress={setActivity}
                  className="h-full"
                />
              </div>
            )}
            {excludePanelNode}
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
          <div className="relative min-h-0 min-w-0">
            <PdfPreview
              path={filePath}
              className="h-full min-h-[280px]"
              scrollToPage={jumpPage}
              onPageSelect={
                syncEnabled && !excludeMode ? jumpMarkdown : undefined
              }
              renderPageOverlay={excludeMode ? renderExcludeOverlay : undefined}
            />

            {excludePanelNode}
          </div>

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
          extra={
            [
              drawMode ? t("mode.drawTable") : null,
              excludeMode ? t("toolbar.excludeRegion") : null,
            ]
              .filter(Boolean)
              .join(" · ") || undefined
          }
          notices={notices}
          progress={activity}
          ocrConfidence={
            drawMode ? drawOcrConfidence : (result?.ocrConfidence ?? null)
          }
        />
      </div>
    </>
  );
}
