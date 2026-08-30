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
import { GlassPanel } from "@/components/ui/glass-panel";

/** Marker that delimits PDF pages (`<!-- Page N -->`) or images (`<!-- Image N -->`). */
const PAGE_MARKER_RE =
  /<!--\s*(?:Page\s*\d+|Image\s*\d+|第\s*\d+\s*页|第\s*\d+\s*张)\s*-->/g;
/** How far below the viewport a page is pre-rendered before it scrolls in. */
const IO_BUFFER_PX = 600;
/** Placeholder height for not-yet-rendered pages so scrolling stays smooth. */
const PLACEHOLDER_HEIGHT_PX = 240;
/**
 * Line-based chunking kicks in when a document has no page/image markers at
 * all (e.g. a hand-written markdown opened in the Markdown > Excel view), so
 * very large files still get lazy rendering instead of one giant parse.
 * The threshold keeps the per-chunk markdown parse cheap on typical screens.
 */
const CHUNK_LINES = 200;
/** How far past the target the chunker looks for a blank-line boundary. */
const CHUNK_SCAN = 40;

interface MarkdownPage {
  marker: string;
  content: string;
}

/**
 * Split markdown into per-page chunks using the app's own page markers.
 * Each chunk carries the marker that PRECEDES its content, so page N's
 * content is labelled by the `<!-- Page N -->` marker at its start.
 *
 * When the document has no markers at all, it is split into fixed-size line
 * chunks (preferring blank-line boundaries so tables/code fences are not cut
 * mid-block). The chunks carry an empty marker, so they render exactly like
 * the original text - only the lazy mounting is finer-grained.
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

  // Marker-less document: chunk by lines so huge files stay lazy-rendered.
  if (pages.length <= 1 && pages[0]?.content.trim()) {
    const lines = pages[0].content.split("\n");
    if (lines.length > CHUNK_LINES) {
      const chunks: MarkdownPage[] = [];
      let start = 0;
      while (start < lines.length) {
        let end = Math.min(start + CHUNK_LINES, lines.length);
        if (end < lines.length) {
          // Prefer a blank line before `end`, scanning a little forward/back,
          // so a table or code fence spanning the boundary stays intact.
          let back = end;
          while (back > start && back > end - CHUNK_SCAN && lines[back - 1].trim() !== "") {
            back -= 1;
          }
          if (back > start && back >= end - CHUNK_SCAN) {
            end = back;
          } else {
            let forward = end;
            while (forward < lines.length && forward < end + CHUNK_SCAN && lines[forward].trim() !== "") {
              forward += 1;
            }
            if (forward < lines.length && forward < end + CHUNK_SCAN) end = forward;
          }
        }
        chunks.push({ marker: "", content: lines.slice(start, end).join("\n") });
        start = end;
      }
      return chunks;
    }
  }
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
function PageBreakMarker({
  marker,
  clickable,
  active,
  onClick,
}: {
  marker: string;
  clickable?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  const { t } = useI18n();
  const page = marker.match(/\d+/)?.[0];
  if (!page) return null;
  const isImage = /[Ii]mage|张/.test(marker);
  return (
    <div
      role={clickable ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "mb-2 flex items-center gap-2",
        clickable &&
          "-mx-1 cursor-pointer select-none rounded-md px-1 transition-colors hover:bg-accent/70",
        active && "bg-accent text-foreground",
      )}
    >
      <span
        className={cn(
          "whitespace-nowrap text-xs font-semibold uppercase tracking-widest",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {isImage ? t("preview.image", { page }) : t("preview.page", { page })}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

/** Extract the PDF page number from a `<!-- Page N -->` marker; null for image markers. */
function markerPageNumber(marker: string): number | null {
  if (!marker) return null;
  if (/[Ii]mage/.test(marker) || marker.includes("张")) return null;
  const m = marker.match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isInteger(n) && n > 0 ? n : null;
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
  /** Override the export button tooltip (e.g. "Export to Excel" in md→xlsx). */
  exportHint?: string;
  /**
   * Request to scroll this pane to the page whose `<!-- Page N -->` marker
   * matches. The `seq` counter re-triggers the jump even for the same page.
   */
  scrollToPage?: { page: number; seq: number } | null;
  /** Called when a Page block is clicked (page-link mode). */
  onPageSelect?: (page: number) => void;
  className?: string;
}

export function PreviewPane({
  markdown,
  processingTimeMs,
  onExport,
  showPageMarkers = false,
  toolbar,
  exportHint,
  scrollToPage,
  onPageSelect,
  className,
}: PreviewPaneProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"raw" | "render">("render");
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** Index of the page block just jumped to, briefly highlighted. */
  const [focusing, setFocusing] = useState<number | null>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // Paginate the markdown by its page markers and render pages lazily, so
  // large documents don't pay the whole ReactMarkdown + highlight parse at once.
  const pages = useMemo(() => splitMarkdownPages(markdown), [markdown]);
  const [visiblePages, setVisiblePages] = useState<ReadonlySet<number>>(
    () => new Set(pages.length ? [0] : []),
  );
  const articleRef = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  // Last measured height of each page, used to reserve real space for
  // reclaimed (unmounted) pages so scrolling back up doesn't reflow.
  const pageHeightsRef = useRef(new Map<number, number>());
  /**
   * Last scroll offset captured while the pane was visible. Switching tabs
   * hides views with `display:none`, which collapses the scroll container and
   * zeroes its offset - restore it when the pane is shown again so the linked
   * page stays put instead of being lost to the top of the document.
   */
  const savedScrollTopRef = useRef(0);
  const paneVisibleRef = useRef(true);

  useEffect(() => {
    setVisiblePages(new Set(pages.length ? [0] : []));
    pageHeightsRef.current.clear();
    savedScrollTopRef.current = 0;
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

  // Jump this pane to the page whose marker matches the request (PDF side
  // linked back to Markdown). Nearby jumps animate, far jumps land instantly
  // so 1000-page documents still hop in well under the acceptance budget.
  useEffect(() => {
    if (!scrollToPage) return;
    const idx = pages.findIndex(
      (pg) => markerPageNumber(pg.marker) === scrollToPage.page,
    );
    if (idx < 0) return;
    const el = pageRefs.current.get(idx);
    if (!el) return;
    const viewport = el.closest(
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
    setFocusing(idx);
    clearTimeout(focusTimerRef.current);
    focusTimerRef.current = setTimeout(() => setFocusing(null), 1200);
    return () => clearTimeout(focusTimerRef.current);
  }, [scrollToPage, pages]);

  // Snapshot the scroll offset while visible and restore it once the pane is
  // shown again (workspace tabs hide inactive views with display:none, which
  // wipes the scroll container's offset). The offset keeps updating from real
  // scroll events only while the viewport still has a box, so the hide-time
  // collapse to 0 cannot clobber the snapshot.
  useEffect(() => {
    const viewport = rootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!viewport) return;
    // Render/raw mode and a new markdown throw away the pane's layout, so a
    // snapshot captured under the old layout must not be re-applied.
    savedScrollTopRef.current = 0;

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
    <GlassPanel
      ref={rootRef}
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-xl",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b px-3 py-1">
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
          <TooltipContent>{exportHint ?? t("tooltip.exportMarkdown")}</TooltipContent>
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
                        <PageBreakMarker
                          marker={pg.marker}
                          clickable={!!onPageSelect}
                          active={focusing === i}
                          onClick={
                            onPageSelect
                              ? () => {
                                  const n = markerPageNumber(pg.marker);
                                  if (n != null) onPageSelect(n);
                                }
                              : undefined
                          }
                        />
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
    </GlassPanel>
  );
}
