import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import { FileText, Loader2 } from "lucide-react";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

const MAX_DPR = 1.5;
const RESIZE_DEBOUNCE_MS = 150;
const IO_BUFFER_PX = 600;
const DEFAULT_ASPECT = "0.7071";

interface PdfPreviewProps {
  path: string;
  className?: string;
}

export function PdfPreview({ path, className }: PdfPreviewProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const wrapperRefs = useRef(new Map<number, HTMLDivElement>());
  const canvasRefs = useRef(new Map<number, HTMLCanvasElement>());
  const renderedRef = useRef(new Set<number>());
  const docRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const lastWidth = useRef(0);

  const [pageCount, setPageCount] = useState<number | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [visible, setVisible] = useState<ReadonlySet<number>>(new Set());
  const [aspects, setAspects] = useState<Record<number, string>>({});
  const [tick, setTick] = useState(0);

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

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="flex size-5 items-center justify-center text-primary">
          <FileText className="size-4" />
        </span>
        <p className="text-sm font-medium">PDF 预览</p>
        <span className="ml-auto text-xs text-muted-foreground">
          {status === "loading"
            ? "加载中…"
            : status === "error"
              ? "加载失败"
              : `共 ${pageCount ?? 0} 页`}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div
            ref={surfaceRef}
            className="flex flex-col items-center gap-3 bg-muted/40 p-3"
          >
            {status === "loading" && (
              <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
                <span className="text-xs">正在渲染 PDF…</span>
              </div>
            )}
            {status === "error" && (
              <div className="px-6 py-16 text-center text-xs text-muted-foreground">
                无法预览该 PDF, 可点击右上角「提取为 Markdown」继续
              </div>
            )}
            {status === "ready" &&
              Array.from({ length: pageCount ?? 0 }, (_, i) => (
                <div
                  key={i}
                  data-page={i + 1}
                  ref={(el) => {
                    if (el) wrapperRefs.current.set(i + 1, el);
                    else wrapperRefs.current.delete(i + 1);
                  }}
                  style={{ aspectRatio: aspects[i + 1] ?? DEFAULT_ASPECT }}
                  className="w-full overflow-hidden rounded-md bg-white shadow-sm ring-1 ring-border/40 dark:shadow-none dark:invert dark:hue-rotate-180"
                >
                  <canvas
                    ref={(el) => {
                      if (el) canvasRefs.current.set(i + 1, el);
                      else canvasRefs.current.delete(i + 1);
                    }}
                    className="block h-auto w-full"
                  />
                </div>
              ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
