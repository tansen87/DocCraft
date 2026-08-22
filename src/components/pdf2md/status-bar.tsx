import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  Broom,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/i18n";
import { pdfTypeMeta } from "@/lib/pdf-meta";
import type {
  ActivityProgress,
  DetectResult,
  NoticeLevel,
  StatusNotice,
} from "@/lib/types";
import { cn } from "@/lib/utils";

function Stat({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "flex min-w-0 items-center text-sm font-medium",
          className,
        )}
      >
        {children}
      </span>
    </div>
  );
}

const LEVEL_META: Record<
  NoticeLevel,
  { icon: typeof Info; className: string; dotClass: string }
> = {
  info: {
    icon: Info,
    className: "text-sky-600 dark:text-sky-400",
    dotClass: "bg-sky-500",
  },
  warning: {
    icon: AlertTriangle,
    className: "text-amber-600 dark:text-amber-400",
    dotClass: "bg-amber-500",
  },
  error: {
    icon: XCircle,
    className: "text-red-600 dark:text-red-400",
    dotClass: "bg-red-500",
  },
};

/** Human-readable label for the in-flight activity phase. */
function progressLabel(
  progress: ActivityProgress,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (progress.phase === "ocr") {
    if (progress.total && progress.current) {
      return t("status.progressOcr", {
        current: Math.min(progress.current, progress.total),
        total: progress.total,
      });
    }
    return t("status.progressOcrPlain");
  }
  if (progress.phase === "imageOcr") {
    if (progress.total && progress.current) {
      return t("status.progressImageOcr", {
        current: Math.min(progress.current, progress.total),
        total: progress.total,
      });
    }
    return t("status.progressOcrPlain");
  }
  return t("status.progressExtract");
}

/** Pages shown at each end before the middle collapses into a "+N" badge. */
const PAGE_EDGE_COUNT = 2;

/**
 * Clickable page-number chips for one notice. Long lists collapse to the
 * first/last `PAGE_EDGE_COUNT` entries with a "+N" badge for the rest; the
 * chevron buttons step through every affected page (wrapping around) and the
 * inline input jumps straight to any page.
 */
function NoticePageChips({
  pages,
  onPageClick,
}: {
  pages: number[];
  onPageClick?: (page: number) => void;
}) {
  const { t } = useI18n();
  const sorted = useMemo(
    () => [...new Set(pages)].sort((a, b) => a - b),
    [pages],
  );
  const key = sorted.join(",");

  // Index into `sorted` of the page currently being viewed via stepping.
  const [cursor, setCursor] = useState(0);
  useEffect(() => setCursor(0), [key]);

  const [draft, setDraft] = useState("");

  const jump = useCallback(
    (page: number) => {
      const idx = sorted.indexOf(page);
      if (idx >= 0) setCursor(idx);
      onPageClick?.(page);
    },
    [sorted, onPageClick],
  );

  const step = useCallback(
    (delta: number) => {
      if (!onPageClick || sorted.length === 0) return;
      const next = (cursor + delta + sorted.length) % sorted.length;
      setCursor(next);
      onPageClick(sorted[next]);
    },
    [cursor, sorted, onPageClick],
  );

  if (sorted.length === 0) return null;

  const interactive = Boolean(onPageClick);
  // Tiny lists render every chip; longer ones show a sliding window of
  // PAGE_EDGE_COUNT pages starting at the cursor plus the last
  // PAGE_EDGE_COUNT pages, collapsing everything in between into a badge.
  const collapsed = sorted.length > PAGE_EDGE_COUNT * 2;
  const windowPages = collapsed
    ? sorted.slice(cursor, cursor + PAGE_EDGE_COUNT)
    : sorted;
  const tailPages = collapsed ? sorted.slice(-PAGE_EDGE_COUNT) : [];
  const visibleSet = new Set([...windowPages, ...tailPages]);
  const visiblePages = sorted.filter((p) => visibleSet.has(p));
  const hiddenCount = collapsed ? sorted.length - visiblePages.length : 0;

  const chip = (page: number) => (
    <Button
      key={page}
      variant="secondary"
      size="icon-xs"
      disabled={!onPageClick}
      onClick={() => jump(page)}
    >
      {page}
    </Button>
  );

  return (
    <div className="flex flex-wrap items-center gap-1">
      {interactive ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={() => step(-1)}>
              <ChevronLeft className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("status.pagePrev")}</TooltipContent>
        </Tooltip>
      ) : null}

      {visiblePages.map(chip)}

      {collapsed && hiddenCount > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
              +{hiddenCount}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {t("status.pagesHidden", { count: hiddenCount })}
          </TooltipContent>
        </Tooltip>
      ) : null}

      {interactive ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={() => step(1)}>
              <ChevronRight className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("status.pageNext")}</TooltipContent>
        </Tooltip>
      ) : null}

      {interactive ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const page = Number.parseInt(draft, 10);
                if (Number.isFinite(page) && page >= 1) {
                  jump(page);
                  setDraft("");
                  e.currentTarget.blur();
                }
              }}
              placeholder={t("status.jumpPagePlaceholder")}
              className="ml-auto h-6 w-16 rounded border border-border bg-transparent px-1.5 text-[11px] tabular-nums outline-none placeholder:text-muted-foreground/60 focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-ring"
            />
          </TooltipTrigger>
          <TooltipContent>{t("status.jumpPageAria")}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

interface StatusBarProps {
  result: DetectResult | null;
  loading: boolean;
  extra?: string;
  /** Structured notices rendered in the bell popover. */
  notices?: StatusNotice[];
  /** In-flight task shown as a spinner + stage label next to the bell. */
  progress?: ActivityProgress | null;
  /**
   * Hide the PDF-specific stats (type / confidence / OCR pages) for views
   * that have no PDF context (e.g. image conversion).
   */
  hidePdfStats?: boolean;
}

export function StatusBar({
  result,
  loading,
  extra,
  notices,
  progress,
  hidePdfStats = false,
}: StatusBarProps) {
  const { t } = useI18n();
  const meta = result ? pdfTypeMeta[result.pdfType] : null;
  const needsOcr = result?.pagesNeedingOcr.length ?? 0;

  const items = useMemo(() => notices ?? [], [notices]);

  // Read / dismissed tracking keyed by notice id (ids are stable across
  // renders; content changes keep the same id on purpose so a persistent
  // problem stays visible after a re-extraction).
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  const visible = useMemo(
    () => items.filter((n) => !dismissed.has(n.id)),
    [items, dismissed],
  );
  const unreadCount = visible.filter((n) => !seen.has(n.id)).length;

  // Opening the popover marks everything as read.
  useEffect(() => {
    if (!open || visible.length === 0) return;
    setSeen((prev) => {
      const next = new Set(prev);
      for (const n of visible) next.add(n.id);
      return next.size === prev.size ? prev : next;
    });
  }, [open, visible]);

  const severity = visible.reduce<NoticeLevel>(
    (acc, n) =>
      n.level === "error" || acc === "error"
        ? "error"
        : n.level === "warning" || acc === "warning"
          ? "warning"
          : "info",
    "info",
  );
  const levelMeta = LEVEL_META[severity];

  const clearAll = () => {
    setDismissed((prev) => {
      const next = new Set(prev);
      for (const n of visible) next.add(n.id);
      return next;
    });
  };

  const pdfTypeLabel = result
    ? {
        TextBased: t("pdfmeta.text"),
        Mixed: t("pdfmeta.mixed"),
        Scanned: t("pdfmeta.scanned"),
        ImageBased: t("pdfmeta.image"),
      }[result.pdfType]
    : null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-card px-4 py-2 shadow-sm">
      {hidePdfStats ? null : (
        <>
          <Stat label={t("status.pdfType")}>
            {loading ? (
              <Skeleton className="h-5 w-20" />
            ) : result ? (
              <Badge variant="outline" className={meta?.badgeClass}>
                {meta && <meta.icon className="mr-1 size-3" />}
                {pdfTypeLabel ?? t("status.unknown")}
              </Badge>
            ) : (
              <span className="text-muted-foreground">
                {t("status.notDetected")}
              </span>
            )}
          </Stat>

          <span className="hidden h-4 w-px bg-border sm:block" />

          <Stat label={t("status.confidence")}>
            {loading ? (
              <Skeleton className="h-5 w-12" />
            ) : result ? (
              `${Math.round(result.confidence * 100)}%`
            ) : (
              "—"
            )}
          </Stat>

          <span className="hidden h-4 w-px bg-border sm:block" />
        </>
      )}

      {hidePdfStats ? null : (
        <Stat
          label={t("status.ocrNeed")}
          className={cn(
            needsOcr > 0
              ? "text-amber-600 dark:text-amber-400"
              : result
                ? "text-emerald-600 dark:text-emerald-400"
                : undefined,
          )}
        >
          {loading ? (
            <Skeleton className="h-5 w-16" />
          ) : result ? (
            needsOcr > 0 ? (
              t("table.pages", { count: needsOcr })
            ) : (
              t("status.none")
            )
          ) : (
            "—"
          )}
        </Stat>
      )}

      {extra ? (
        <>
          <span className="hidden h-4 w-px bg-border sm:block" />
          <Stat label={t("status.mode")}>
            <Badge variant="secondary" className="text-xs">
              {extra}
            </Badge>
          </Stat>
        </>
      ) : null}

      <div className="ml-auto flex items-center gap-3">
        {/* In-flight activity indicator */}
        {progress ? (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <Loader2 className="size-3.5 animate-spin text-primary" />
            <span>{progressLabel(progress, t)}</span>
          </div>
        ) : null}

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "relative flex size-8 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                unreadCount > 0
                  ? cn(levelMeta.className, "hover:bg-muted/60")
                  : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              <Bell className="size-4" />
              {unreadCount > 0 ? (
                <span
                  className={cn(
                    "absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-4 text-white",
                    levelMeta.dotClass,
                  )}
                >
                  {unreadCount}
                </span>
              ) : null}
              <span className="sr-only" aria-live="polite">
                {unreadCount > 0
                  ? t("status.unreadNotices", { count: unreadCount })
                  : null}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-96">
            <div className="space-y-1 mt-[-4px]">
              <div className="flex items-center gap-2">
                <p className="flex flex-1 items-center gap-2 text-xs font-medium">
                  <Bell className="size-3.5" />
                  {t("status.notices")}
                  {visible.length > 0 ? (
                    <Badge variant="secondary" className="px-1.5 text-[10px]">
                      {visible.length}
                    </Badge>
                  ) : null}
                </p>
                {visible.length > 0 ? (
                  <Button variant="ghost" size="sm" onClick={clearAll}>
                    <Broom className="size-3.5" />
                    {t("status.noticesClear")}
                  </Button>
                ) : null}
              </div>
              {visible.length === 0 ? (
                <p className="py-2 text-xs text-muted-foreground">
                  {t("status.noticesEmpty")}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {visible.map((n) => {
                    const m = LEVEL_META[n.level];
                    return (
                      <div
                        key={n.id}
                        className="space-y-1.5 rounded-lg border bg-background/50 p-2"
                      >
                        <p
                          className={cn(
                            "flex items-start gap-1.5 text-xs font-medium",
                            m.className,
                          )}
                        >
                          <m.icon className="mt-px size-3.5 shrink-0" />
                          {n.text}
                        </p>
                        {n.pages?.length ? (
                          <NoticePageChips
                            pages={n.pages}
                            onPageClick={n.onPageClick}
                          />
                        ) : null}
                        {n.actions?.length ? (
                          <div className="flex flex-wrap gap-1.5 pt-0.5">
                            {n.actions.map((action) => (
                              <Button
                                key={action.label}
                                variant="secondary"
                                size="sm"
                                className="h-6 px-2 text-[11px]"
                                onClick={action.onClick}
                              >
                                {action.label}
                              </Button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
