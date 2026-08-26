import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

import "highlight.js/styles/github-dark.css";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useI18n } from "@/i18n";
import { formatDuration } from "@/lib/format-duration";
import { cn } from "@/lib/utils";

/** Marker that delimits PDF pages (`<!-- Page N -->`) or images (`<!-- Image N -->`). */
const PAGE_MARKER_RE =
  /<!--\s*(?:Page\s*\d+|Image\s*\d+|第\s*\d+\s*页|第\s*\d+\s*张)\s*-->/g;
/** How far below the viewport a page is pre-rendered before it scrolls in. */
const IO_BUFFER_PX = 600;
/** Placeholder height for not-yet-rendered pages so scrolling stays smooth. */
const PLACEHOLDER_HEIGHT_PX = 240;

interface MarkdownPage {
  marker: string;
  content: string;
}

/**
 * Split markdown into per-page chunks using the app's own page markers.
 * Each chunk carries the marker that PRECEDES its content, so page N's
 * content is labelled by the `<!-- Page N -->` marker at its start.
 */
function splitMarkdownPages(markdown: string): MarkdownPage[] {
  const pages: MarkdownPage[] = [];
  const re = new RegExp(PAGE_MARKER_RE.source, "g");
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let pendingMarker = "";
  while ((match = re.exec(markdown)) !== null) {
    pages.push({
      marker: pendingMarker,
      content: markdown.slice(lastIndex, match.index),
    });
    pendingMarker = match[0];
    lastIndex = match.index + match[0].length;
  }
  pages.push({ marker: pendingMarker, content: markdown.slice(lastIndex) });
  return pages;
}

/** Memoized per-page renderer: re-parses only when its own chunk changes. */
const MarkdownPageView = memo(function MarkdownPageView({
  markdown,
}: {
  markdown: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
    >
      {markdown}
    </ReactMarkdown>
  );
});

/** Visible "Page N" / "Image N" divider shown at each marker when enabled. */
function PageBreakMarker({ marker }: { marker: string }) {
  const { t } = useI18n();
  const page = marker.match(/\d+/)?.[0];
  if (!page) return null;
  const isImage = /[Ii]mage|张/.test(marker);
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="whitespace-nowrap text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {isImage ? t("preview.image", { page }) : t("preview.page", { page })}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

interface PreviewPaneProps {
  markdown: string;
  processingTimeMs: number;
  /** Export the markdown. The caller shows its own success/failure toast. */
  onExport: () => Promise<void>;
  /** Render visible "Page N" dividers at each page marker (default: hidden). */
  showPageMarkers?: boolean;
  /** Optional extra controls rendered in the header before the mode toggle. */
  toolbar?: ReactNode;
  className?: string;
}

export function PreviewPane({
  markdown,
  processingTimeMs,
  onExport,
  showPageMarkers = false,
  toolbar,
  className,
}: PreviewPaneProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"raw" | "render">("render");
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Paginate the markdown by its page markers and render pages lazily, so
  // large documents don't pay the whole ReactMarkdown + highlight parse at once.
  const pages = useMemo(() => splitMarkdownPages(markdown), [markdown]);
  const [visiblePages, setVisiblePages] = useState<ReadonlySet<number>>(
    () => new Set(pages.length ? [0] : []),
  );
  const articleRef = useRef<HTMLElement | null>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  // Last measured height of each page, used to reserve real space for
  // reclaimed (unmounted) pages so scrolling back up doesn't reflow.
  const pageHeightsRef = useRef(new Map<number, number>());

  useEffect(() => {
    setVisiblePages(new Set(pages.length ? [0] : []));
    pageHeightsRef.current.clear();
  }, [pages]);

  // Measure a mounted page's height once so its reclaimed placeholder can
  // reserve the same space (avoids the scroll-up reflow / stuck feedback loop).
  const measurePage = useCallback(
    (i: number) => (el: HTMLDivElement | null) => {
      if (el && !pageHeightsRef.current.has(i)) {
        pageHeightsRef.current.set(i, el.offsetHeight);
      }
    },
    [],
  );

  useEffect(() => {
    if (pages.length <= 1) return;
    const root =
      (articleRef.current?.closest(
        '[data-slot="scroll-area-viewport"]',
      ) as Element | null) ?? null;
    const io = new IntersectionObserver(
      (entries) => {
        setVisiblePages((prev) => {
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
    for (const el of pageRefs.current.values()) io.observe(el);
    return () => io.disconnect();
  }, [mode, pages]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("toast.copyFailed"));
    }
  }

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    try {
      await onExport();
    } finally {
      setExporting(false);
    }
  }

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-xl glass-panel",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <p className="truncate text-sm font-medium">
            {t("preview.markdown")}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {t("preview.timeChars", {
              time: formatDuration(processingTimeMs),
              chars: markdown.length,
            })}
          </p>
        </div>
        {toolbar}
        <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
          <button
            type="button"
            onClick={() => setMode("render")}
            className={cn(
              "rounded-md px-2 py-1 text-xs font-medium transition-colors",
              mode === "render"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t("preview.render")}
          </button>
          <button
            type="button"
            onClick={() => setMode("raw")}
            className={cn(
              "rounded-md px-2 py-1 text-xs font-medium transition-colors",
              mode === "raw"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t("preview.raw")}
          </button>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={copy}>
              {copied ? <Check /> : <Copy />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("tooltip.copy")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleExport}
              disabled={exporting}
            >
              {exporting ? <Loader2 className="animate-spin" /> : <Download />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("tooltip.exportMarkdown")}</TooltipContent>
        </Tooltip>
      </div>

      {mode === "raw" ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-4">
            {pages.map((pg, i) => (
              <div
                key={i}
                data-page={i}
                ref={(el) => {
                  if (el) pageRefs.current.set(i, el);
                  else pageRefs.current.delete(i);
                }}
                style={
                  visiblePages.has(i)
                    ? undefined
                    : {
                        height:
                          pageHeightsRef.current.get(i) ??
                          PLACEHOLDER_HEIGHT_PX,
                      }
                }
              >
                {visiblePages.has(i) ? (
                  <div ref={measurePage(i)}>
                    <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
                      {pg.marker}
                      {pg.content}
                    </pre>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </ScrollArea>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <article ref={articleRef} className="markdown-body p-4">
            {pages.map((pg, i) => (
              <div
                key={i}
                data-page={i}
                ref={(el) => {
                  if (el) pageRefs.current.set(i, el);
                  else pageRefs.current.delete(i);
                }}
                style={
                  visiblePages.has(i)
                    ? undefined
                    : {
                        height:
                          pageHeightsRef.current.get(i) ??
                          PLACEHOLDER_HEIGHT_PX,
                      }
                }
              >
                {visiblePages.has(i) ? (
                  <div ref={measurePage(i)}>
                    {showPageMarkers && pg.marker ? (
                      <div>
                        <PageBreakMarker marker={pg.marker} />
                        <MarkdownPageView markdown={pg.content} />
                      </div>
                    ) : (
                      <MarkdownPageView markdown={pg.marker + pg.content} />
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </article>
        </ScrollArea>
      )}
    </div>
  );
}
