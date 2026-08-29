import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import { FileText } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { GlassPanel } from "@/components/ui/glass-panel";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

const MAX_DPR = 1.5;
const RESIZE_DEBOUNCE_MS = 150;
const IO_BUFFER_PX = 600;
const DEFAULT_ASPECT = "0.7071";

/**
 * The rendered page grid. The actual bitmaps live in canvases owned by the
 * parent (via callback refs), so this list is pure with respect to props and
 * free of state/context - memoizing it keeps bulk language/theme re-renders of
 * the surrounding panes from rebuilding hundreds of page wrappers.
 */
const PageGrid = memo(function PageGrid({
  pageCount,
  aspects,
  focusing,
  onPageSelect,
  renderPageOverlay,
  onWrapperRef,
  onCanvasRef,
}: {
  pageCount: number;
  aspects: Record<number, string>;
  focusing: number | null;
  onPageSelect?: (page: number) => void;
  renderPageOverlay?: (page: number) => ReactNode;
  onWrapperRef: (page: number) => (el: HTMLDivElement | null) => void;
  onCanvasRef: (page: number) => (el: HTMLCanvasElement | null) => void;
}) {
  return (
    <>
      {Array.from({ length: pageCount }, (_, i) => (
        <div
          key={i}
          data-page={i + 1}
          ref={onWrapperRef(i + 1)}
          onClick={onPageSelect ? () => onPageSelect(i + 1) : undefined}
          role={onPageSelect ? "button" : undefined}
          style={{ aspectRatio: aspects[i + 1] ?? DEFAULT_ASPECT }}
          className={cn("w-full", onPageSelect && "cursor-pointer")}
        >
          {/* Ring/hover states live OUTSIDE the dark-mode invert filter
              so they always use the theme accent color, not the
              hue-rotated inverse of it. */}
          <div
            className={cn(
              "relative h-full w-full overflow-hidden rounded-md shadow-sm ring-1 ring-border/40 transition-shadow dark:shadow-none",
              onPageSelect && "hover:ring-2 hover:ring-primary/70",
              focusing === i + 1 && "ring-2 ring-primary",
            )}
          >
            <div className="h-full w-full overflow-hidden rounded-md bg-white dark:invert dark:hue-rotate-180">
              <canvas
                ref={onCanvasRef(i + 1)}
                className="block h-auto w-full"
              />
            </div>
            {/* Overlays (exclusion regions) sit outside the dark-mode
                invert filter so their colors stay true to the theme. */}
            {renderPageOverlay?.(i + 1)}
          </div>
        </div>
      ))}
    </>
  );
});

interface PdfPreviewProps {
  path: string;
  className?: string;
  /**
   * Request to scroll the preview to a page. The `seq` counter re-triggers
   * the scroll even when the same page is requested twice in a row.
   */
  scrollToPage?: { page: number; seq: number } | null;
  /** Called when a rendered page is clicked (page-link mode). */
  onPageSelect?: (page: number) => void;
  /**
   * Optional layer rendered on top of each page (1-indexed). Used by the
   * exclusion-region editor, which measures its own box to map CSS pixels to
   * PDF points.
   */
  renderPageOverlay?: (page: number) => ReactNode;
}

export function PdfPreview({
  path,
  className,
  scrollToPage,
  onPageSelect,
  renderPageOverlay,
}: PdfPreviewProps) {
  const { t } = useI18n();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const wrapperRefs = useRef(new Map<number, HTMLDivElement>());
  const canvasRefs = useRef(new Map<number, HTMLCanvasElement>());
  const renderedRef = useRef(new Set<number>());
  const docRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const lastWidth = useRef(0);
  /** Page number just jumped to, briefly highlighted. */
  const [focusing, setFocusing] = useState<number | null>(null);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  /**
   * Last scroll offset captured while the pane was visible. Switching tabs
   * hides views with `display:none`, which collapses the scroll container and
   * zeroes its offset - restore it when the pane is shown again so the linked
   * page stays put instead of being lost to the top of the document.
   */
  const savedScrollTopRef = useRef(0);
  const paneVisibleRef = useRef(true);

  const [pageCount, setPageCount] = useState<number | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [visible, setVisible] = useState<ReadonlySet<number>>(new Set());
  const [aspects, setAspects] = useState<Record<number, string>>({});
  const [tick, setTick] = useState(0);

  // Stable callback refs handed to the memoized PageGrid so parent re-renders
  // (language/theme) don't cheapen the memo: the grid can rebuild its entries
  // without those callbacks changing identity on the parent's own re-render.
  const onWrapperRef = useCallback(
    (page: number) => (el: HTMLDivElement | null) => {
      if (el) wrapperRefs.current.set(page, el);
      else wrapperRefs.current.delete(page);
    },
    [],
  );
  const onCanvasRef = useCallback(
    (page: number) => (el: HTMLCanvasElement | null) => {
      if (el) canvasRefs.current.set(page, el);
      else canvasRefs.current.delete(page);
    },
    [],
  );

  useEffect(() => {
    const el = surfaceRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    lastWidth.current = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (Math.abs(w - lastWidth.current) > 4) {
        lastWidth.current = w;
        clearTimeout(resizeTimer.current);
        resizeTimer.current = setTimeout(() => {
          renderedRef.current.clear();
          for (const canvas of canvasRefs.current.values()) {
            canvas.width = 0;
            canvas.height = 0;
          }
          setTick((t) => t + 1);
        }, RESIZE_DEBOUNCE_MS);
      }
    });
    ro.observe(el);
    return () => {
      clearTimeout(resizeTimer.current);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setPageCount(null);
    canvasRefs.current.clear();
    wrapperRefs.current.clear();
    renderedRef.current.clear();
    savedScrollTopRef.current = 0;
    setVisible(new Set());
    setAspects({});

    const task = pdfjs.getDocument({ url: convertFileSrc(path) });
    task.promise
      .then((doc) => {
        if (cancelled) return;
        docRef.current = doc;
        setPageCount(doc.numPages);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
      docRef.current = null;
      task.destroy();
    };
  }, [path]);

  // Snapshot the scroll offset while visible and restore it once the pane is
  // shown again (workspace tabs hide inactive views with display:none, which
  // wipes the scroll container's offset). The offset keeps updating from real
  // scroll events only while the viewport still has a box, so the hide-time
  // collapse to 0 cannot clobber the snapshot.
  useEffect(() => {
    const surface = surfaceRef.current;
    const viewport = surface?.closest(
      '[data-slot="scroll-area-viewport"]',
    ) as HTMLElement | null;
    if (!viewport) return;

    const onScroll = () => {
      if (paneVisibleRef.current && viewport.clientHeight > 0) {
        savedScrollTopRef.current = viewport.scrollTop;
      }
    };
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          paneVisibleRef.current = true;
          if (savedScrollTopRef.current > 0) {
            const top = savedScrollTopRef.current;
            savedScrollTopRef.current = 0;
            viewport.scrollTop = top;
          }
        } else {
          paneVisibleRef.current = false;
        }
      }
    });
    viewport.addEventListener("scroll", onScroll, { passive: true });
    io.observe(viewport);
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      io.disconnect();
    };
  }, [status]);

  useEffect(() => {
    if (status !== "ready" || !pageCount) return;
    const root =
      (surfaceRef.current?.closest(
        '[data-slot="scroll-area-viewport"]',
      ) as Element | null) ?? null;
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          let changed = false;
          const next = new Set(prev);
          for (const entry of entries) {
            const idx = Number((entry.target as HTMLElement).dataset.page);
            if (Number.isNaN(idx)) continue;
            if (entry.isIntersecting) {
              if (!next.has(idx)) {
                next.add(idx);
                changed = true;
              }
            } else if (next.delete(idx)) {
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { root, rootMargin: `${IO_BUFFER_PX}px 0px` },
    );

    for (const el of wrapperRefs.current.values()) io.observe(el);
    return () => io.disconnect();
  }, [status, pageCount, path]);

  useEffect(() => {
    if (status !== "ready" || !pageCount) return;
    const doc = docRef.current;
    if (!doc) return;
    let cancelled = false;

    const renderPage = async (pageNum: number) => {
      if (cancelled || renderedRef.current.has(pageNum)) return;
      const canvas = canvasRefs.current.get(pageNum);
      const wrapper = wrapperRefs.current.get(pageNum);
      if (!canvas || !wrapper) return;
      try {
        const page = await doc.getPage(pageNum);
        if (cancelled) return;
        const width =
          wrapper.clientWidth || surfaceRef.current?.clientWidth || 600;
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        const base = page.getViewport({ scale: 1 });
        const scale = (width * dpr) / base.width;
        const viewport = page.getViewport({ scale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvas, viewport }).promise;
        }
        if (cancelled) return;
        const ratio = base.width / base.height;
        setAspects((prev) =>
          prev[pageNum] ? prev : { ...prev, [pageNum]: ratio.toFixed(4) },
        );
        renderedRef.current.add(pageNum);
        page.cleanup();
      } catch {
        renderedRef.current.add(pageNum);
      }
    };

    const targets = [...visible].filter((p) => !renderedRef.current.has(p));
    void Promise.all(targets.map(renderPage));

    return () => {
      cancelled = true;
    };
  }, [status, pageCount, tick, path, visible]);

  useEffect(() => {
    for (const [pageNum, canvas] of canvasRefs.current) {
      if (!visible.has(pageNum) && (canvas.width > 0 || canvas.height > 0)) {
        canvas.width = 0;
        canvas.height = 0;
        renderedRef.current.delete(pageNum);
      }
    }
  }, [visible]);

  // Jump to a requested page (status bar notice chips / Markdown page-link).
  // The page renders on demand once the IntersectionObserver sees it after the
  // scroll. Nearby jumps animate; far jumps land instantly so 1000-page
  // documents still hop in well under the acceptance budget.
  useEffect(() => {
    if (!scrollToPage || status !== "ready") return;
    const el = wrapperRefs.current.get(scrollToPage.page);
    if (!el) return;
    const viewport = surfaceRef.current?.closest(
      '[data-slot="scroll-area-viewport"]',
    ) as HTMLElement | null;
    if (viewport) {
      const delta =
        el.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      el.scrollIntoView({
        behavior:
          Math.abs(delta) < viewport.clientHeight * 3 ? "smooth" : "auto",
        block: "start",
      });
    } else {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    setFocusing(scrollToPage.page);
    clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => setFocusing(null), 1200);
    return () => clearTimeout(focusTimer.current);
  }, [scrollToPage, status]);

  return (
    <GlassPanel
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <span className="flex size-5 items-center justify-center text-primary">
          <FileText className="size-4" />
        </span>
        <p className="text-sm font-medium">{t("preview.pdf")}</p>
        <span className="ml-auto text-xs text-muted-foreground">
          {status === "loading"
            ? t("preview.loading")
            : status === "error"
              ? t("preview.loadFailed")
              : t("preview.totalPages", { count: pageCount ?? 0 })}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div
            ref={surfaceRef}
            className="flex flex-col items-center gap-3 bg-muted/40 p-3"
          >
            {status === "loading" && (
              <div className="flex flex-col items-center gap-4 py-16">
                <Skeleton className="h-[280px] w-[200px] rounded-md" />
                <Skeleton className="h-[280px] w-[200px] rounded-md" />
                <Skeleton className="h-[280px] w-[200px] rounded-md" />
              </div>
            )}
            {status === "error" && (
              <div className="px-6 py-16 text-center text-xs text-muted-foreground">
                {t("preview.cannotPreview")}
              </div>
            )}
            {status === "ready" && pageCount ? (
              <PageGrid
                pageCount={pageCount}
                aspects={aspects}
                focusing={focusing}
                onPageSelect={onPageSelect}
                renderPageOverlay={renderPageOverlay}
                onWrapperRef={onWrapperRef}
                onCanvasRef={onCanvasRef}
              />
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </GlassPanel>
  );
}
