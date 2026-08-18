import { useCallback, useEffect, useRef, useState } from "react";
import { Table2 } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

/** Rows mounted per table on first render (keeps the initial DOM small). */
const INITIAL_ROWS = 50;
/** Extra rows revealed each time a table's tail scrolls into view. */
const ROW_STEP = 100;
/** How far below the viewport content is pre-rendered before it scrolls in. */
const IO_BUFFER_PX = 600;
/** Placeholder height for not-yet-mounted table sections. */
const PLACEHOLDER_HEIGHT_PX = 96;

interface TablePreviewProps {
  tableCount: number;
  totalRows: number;
  tables: { columns: string[]; rows: string[][] }[];
  className?: string;
}

export function TablePreview({
  tableCount,
  totalRows,
  tables,
  className,
}: TablePreviewProps) {
  const { t } = useI18n();

  // Per-table number of rows currently mounted in the DOM.
  const [rowWindows, setRowWindows] = useState<number[]>(() =>
    tables.map(() => INITIAL_ROWS),
  );
  // Table sections that are mounted (rendered lazily as they scroll into view).
  const [visibleTables, setVisibleTables] = useState<ReadonlySet<number>>(
    () => new Set(tables.length ? [0] : []),
  );

  // Track observer targets so elements mounted before the observer exists
  // (first render) still get observed once it is created.
  const targetsRef = useRef<Set<HTMLElement>>(new Set());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const observe = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    targetsRef.current.add(el);
    observerRef.current?.observe(el);
    return () => {
      targetsRef.current.delete(el);
      observerRef.current?.unobserve(el);
    };
  }, []);

  // Reset windowing state when a different document is analyzed.
  useEffect(() => {
    setRowWindows(tables.map(() => INITIAL_ROWS));
    setVisibleTables(new Set(tables.length ? [0] : []));
  }, [tables]);

  const handleIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      // Mount table sections once their placeholder scrolls into view.
      setVisibleTables((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          const i = Number(el.dataset.table);
          if (Number.isNaN(i) || el.dataset.type !== "table") continue;
          if (!next.has(i)) {
            next.add(i);
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      // Reveal more rows of a table once its tail scrolls into view.
      setRowWindows((prev) => {
        let changed = false;
        const next = [...prev];
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          if (el.dataset.type !== "rows") continue;
          const i = Number(el.dataset.table);
          if (Number.isNaN(i)) continue;
          const total = tables[i]?.rows.length ?? 0;
          const current = next[i] ?? INITIAL_ROWS;
          if (current >= total) continue;
          next[i] = Math.min(current + ROW_STEP, total);
          changed = true;
        }
        return changed ? next : prev;
      });
    },
    [tables],
  );

  useEffect(() => {
    const root = contentRef.current?.closest(
      '[data-slot="scroll-area-viewport"]',
    ) as Element | null;
    const io = new IntersectionObserver(handleIntersect, {
      root,
      rootMargin: `${IO_BUFFER_PX}px 0px`,
    });
    observerRef.current = io;
    for (const el of targetsRef.current) io.observe(el);
    return () => io.disconnect();
  }, [handleIntersect]);

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
            {t("tablepreview.title")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("tablepreview.summary", { count: tableCount, rows: totalRows })}
          </p>
        </div>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Table2 className="size-4" />
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div ref={contentRef} className="space-y-6 p-4">
          {tables.length > 0 ? (
            tables.map((table, i) =>
              visibleTables.has(i) ? (
                <section key={i} className="space-y-2">
                  {tables.length > 1 ? (
                    <p className="text-xs font-medium text-muted-foreground">
                      {t("tablepreview.table", { index: i + 1 })}
                    </p>
                  ) : null}
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr>
                          {table.columns.map((c, ci) => (
                            <th
                              key={ci}
                              className="border-b bg-muted/60 px-3 py-1.5 text-left text-xs font-medium"
                            >
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {table.rows
                          .slice(0, rowWindows[i] ?? INITIAL_ROWS)
                          .map((r, ri) => (
                            <tr key={ri}>
                              {r.map((cell, ci) => (
                                <td
                                  key={ci}
                                  className="border-b px-3 py-1.5 last:border-0"
                                >
                                  {cell}
                                </td>
                              ))}
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  {(rowWindows[i] ?? INITIAL_ROWS) < table.rows.length ? (
                    <div
                      data-type="rows"
                      data-table={i}
                      ref={observe}
                      className="py-1 text-center text-xs text-muted-foreground"
                    >
                      {t("tablepreview.loadMore")}
                    </div>
                  ) : null}
                </section>
              ) : (
                <div
                  key={i}
                  data-type="table"
                  data-table={i}
                  ref={observe}
                  className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground"
                  style={{ minHeight: PLACEHOLDER_HEIGHT_PX }}
                >
                  {tables.length > 1
                    ? t("tablepreview.table", { index: i + 1 })
                    : null}
                </div>
              ),
            )
          ) : (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
              <Table2 className="size-6" />
              {t("tablepreview.empty")}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
