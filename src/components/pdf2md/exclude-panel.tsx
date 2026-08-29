import { Eraser, SquareDashedMousePointer, X } from "lucide-react";

import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { GlassPanel } from "@/components/ui/glass-panel";
import type { PageExclude } from "@/lib/types";

interface ExcludePanelProps {
  /** Pages that carry at least one rect. */
  pages: PageExclude[];
  /** True while the per-page geometry is still being read. */
  loading: boolean;
  useForAllPages: boolean;
  onUseForAllPagesChange: (value: boolean) => void;
  onClear: () => void;
  onRemove: (page: number, index: number) => void;
}

/**
 * Floating inspector for the exclusion regions of the open document: the
 * apply-to-every-page switch, the list of drawn rects and a clear-all action.
 */
export function ExcludePanel({
  pages,
  loading,
  useForAllPages,
  onUseForAllPagesChange,
  onClear,
  onRemove,
}: ExcludePanelProps) {
  const { t } = useI18n();
  const entries = pages.flatMap((page) =>
    page.rects.map((rect, index) => ({ page: page.page, rect, index })),
  );

  return (
    <GlassPanel className="absolute right-3 top-11 z-10 w-60 rounded-xl p-3 shadow-lg">
      <div className="flex items-center gap-2">
        <SquareDashedMousePointer className="size-4 shrink-0 text-primary" />
        <p className="truncate text-sm font-medium">{t("exclude.title")}</p>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {t("exclude.rectCount", { count: entries.length })}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <Label
          htmlFor="exclude-all-pages"
          className="text-xs text-muted-foreground"
        >
          {t("exclude.applyAllPages")}
        </Label>
        <Switch
          id="exclude-all-pages"
          checked={useForAllPages}
          onCheckedChange={onUseForAllPagesChange}
        />
      </div>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
        {t("exclude.applyAllPagesHint")}
      </p>

      {loading ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("exclude.loading")}
        </p>
      ) : entries.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("exclude.empty")}
        </p>
      ) : (
        <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto">
          {entries.map(({ page, rect, index }) => (
            <li
              key={`${page}-${index}`}
              className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1"
            >
              <span className="shrink-0 rounded bg-background px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
                {t("exclude.page", { page })}
              </span>
              <span className="truncate text-[11px] tabular-nums text-muted-foreground">
                {Math.round(rect.width)} × {Math.round(rect.height)}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto size-5 shrink-0"
                onClick={() => onRemove(page, index)}
                aria-label={t("tooltip.remove")}
              >
                <X className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {entries.length > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-3 w-full"
          onClick={onClear}
        >
          <Eraser />
          {t("exclude.clearAll")}
        </Button>
      ) : null}
    </GlassPanel>
  );
}
