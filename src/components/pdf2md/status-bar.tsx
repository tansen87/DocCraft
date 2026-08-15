import { Bell } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useI18n } from "@/i18n";
import { pdfTypeMeta } from "@/lib/pdf-meta";
import type { DetectResult } from "@/lib/types";
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

interface StatusBarProps {
  result: DetectResult | null;
  loading: boolean;
  extra?: string;
  /** 1-indexed pages skipped because no OCR provider is configured. */
  skippedPages?: number[];
  /** 1-indexed pages whose OCR request failed. */
  failedPages?: number[];
}

export function StatusBar({
  result,
  loading,
  extra,
  skippedPages,
  failedPages,
}: StatusBarProps) {
  const { t } = useI18n();
  const meta = result ? pdfTypeMeta[result.pdfType] : null;
  const needsOcr = result?.pagesNeedingOcr.length ?? 0;

  const skipped = skippedPages ?? [];
  const failed = failedPages ?? [];
  const noticeCount = skipped.length + failed.length;

  const pdfTypeLabel = result
    ? {
        TextBased: t("pdfmeta.text"),
        Mixed: t("pdfmeta.mixed"),
        Scanned: t("pdfmeta.scanned"),
        ImageBased: t("pdfmeta.image"),
      }[result.pdfType]
    : null;

  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded-lg border bg-card px-4 py-2 shadow-sm">
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

      <div className="ml-auto">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                "relative flex size-8 items-center justify-center rounded-lg transition-colors",
                noticeCount > 0
                  ? "text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
                  : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              <Bell className="size-4" />
              {noticeCount > 0 ? (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-4 text-white">
                  {noticeCount}
                </span>
              ) : null}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {noticeCount === 0 ? (
              t("status.noticesEmpty")
            ) : (
              <div className="space-y-1">
                {skipped.length > 0 ? (
                  <p>
                    {t("status.skippedPages", {
                      pages: skipped.join(", "),
                    })}
                  </p>
                ) : null}
                {failed.length > 0 ? (
                  <p>
                    {t("status.failedPages", {
                      pages: failed.join(", "),
                    })}
                  </p>
                ) : null}
              </div>
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
