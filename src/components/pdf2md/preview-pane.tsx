import { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

import "highlight.js/styles/github-dark.css";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

/** Marker that delimits PDF pages in converted Markdown (`<!-- Page N -->`). */
const PAGE_MARKER_RE = /<!--\s*(?:Page\s*\d+|第\s*\d+\s*页)\s*-->/g;
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

/** Visible "Page N" divider shown at each page marker when enabled. */
function PageBreakMarker({ marker }: { marker: string }) {
  const { t } = useI18n();
  const page = marker.match(/\d+/)?.[0];
  if (!page) return null;
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="whitespace-nowrap text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {t("preview.page", { page })}
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
  className?: string;
}

export function PreviewPane({
  markdown,
  processingTimeMs,
  onExport,
  showPageMarkers = false,
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

  useEffect(() => {
    setVisiblePages(new Set(pages.length ? [0] : []));
  }, [pages]);

  useEffect(() => {
    if (mode !== "render" || pages.length <= 1) return;
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
        "flex h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {t("preview.markdown")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("preview.timeChars", {
              time: processingTimeMs,
              chars: markdown.length,
            })}
          </p>
        </div>
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
        <Button variant="ghost" size="icon-xs" onClick={copy}>
          {copied ? <Check className="text-emerald-500" /> : <Copy />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={handleExport}
          disabled={exporting}
          aria-label={t("tooltip.exportMarkdown")}
        >
          {exporting ? <Loader2 className="animate-spin" /> : <Download />}
        </Button>
      </div>

      {mode === "raw" ? (
        <ScrollArea className="min-h-0 flex-1">
          <pre className="whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed">
            {markdown}
          </pre>
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
                    : { minHeight: PLACEHOLDER_HEIGHT_PX }
                }
              >
                {visiblePages.has(i) ? (
                  showPageMarkers && pg.marker ? (
                    <div>
                      <PageBreakMarker marker={pg.marker} />
                      <MarkdownPageView markdown={pg.content} />
                    </div>
                  ) : (
                    <MarkdownPageView markdown={pg.marker + pg.content} />
                  )
                ) : null}
              </div>
            ))}
          </article>
        </ScrollArea>
      )}
    </div>
  );
}
