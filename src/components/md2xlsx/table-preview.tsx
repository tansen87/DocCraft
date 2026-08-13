import { Table2 } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

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
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">表格预览</p>
          <p className="text-xs text-muted-foreground">
            共 {tableCount} 张表格 · {totalRows} 行数据
          </p>
        </div>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Table2 className="size-4" />
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-6 p-4">
          {tables.length > 0 ? (
            tables.map((t, i) => (
              <section key={i} className="space-y-2">
                {tables.length > 1 ? (
                  <p className="text-xs font-medium text-muted-foreground">
                    表格 {i + 1}
                  </p>
                ) : null}
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr>
                        {t.columns.map((c, ci) => (
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
                      {t.rows.map((r, ri) => (
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
              </section>
            ))
          ) : (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
              <Table2 className="size-6" />
              未检测到表格
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
