import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
}

export function StatusBar({ result, loading, extra }: StatusBarProps) {
  const meta = result ? pdfTypeMeta[result.pdfType] : null;
  const needsOcr = result?.pagesNeedingOcr.length ?? 0;

  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded-lg border bg-card px-4 py-2 shadow-sm">
      <Stat label="PDF 类型">
        {loading ? (
          <Skeleton className="h-5 w-20" />
        ) : result ? (
          <Badge variant="outline" className={meta?.badgeClass}>
            {meta && <meta.icon className="mr-1 size-3" />}
            {meta?.label ?? "未知"}
          </Badge>
        ) : (
          <span className="text-muted-foreground">未检测</span>
        )}
      </Stat>

      <span className="hidden h-4 w-px bg-border sm:block" />

      <Stat label="置信度">
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
        label="OCR 需求"
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
            `${needsOcr} 页`
          ) : (
            "无"
          )
        ) : (
          "—"
        )}
      </Stat>

      {extra ? (
        <>
          <span className="hidden h-4 w-px bg-border sm:block" />
          <Stat label="模式">
            <Badge variant="secondary" className="text-xs">
              {extra}
            </Badge>
          </Stat>
        </>
      ) : null}
    </div>
  );
}
