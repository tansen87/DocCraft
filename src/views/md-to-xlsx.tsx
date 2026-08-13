import { useCallback, useRef, useState } from "react";
import { join } from "@tauri-apps/api/path";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  Check,
  Clock,
  Download,
  FileText,
  ListPlus,
  Loader2,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { DragOverlay } from "@/components/pdf2md/drag-overlay";
import { DropZone } from "@/components/pdf2md/drop-zone";
import { useFileDrop } from "@/components/pdf2md/use-pdf-drop";
import { TablePreview } from "@/components/md2xlsx/table-preview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { analyzeMarkdown, exportMarkdownTables } from "@/lib/ipc";
import type { MdAnalyzeResult } from "@/lib/types";
import { cn } from "@/lib/utils";

type MdItemStatus = "queued" | "analyzing" | "ready" | "error";

interface MdItem {
  id: string;
  path: string;
  name: string;
  status: MdItemStatus;
  error?: string;
  result?: MdAnalyzeResult | null;
}

function StatusBadge({ item }: { item: MdItem }) {
  if (item.status === "analyzing") {
    return (
      <Badge className="border-sky-500/30 bg-sky-500/10 text-sky-600 dark:border-sky-500/40 dark:text-sky-400">
        <Loader2 className="size-3 animate-spin" />
        解析中
      </Badge>
    );
  }
  if (item.status === "ready") {
    return (
      <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:border-emerald-500/40 dark:text-emerald-400">
        <Check className="size-3" />
        已就绪
      </Badge>
    );
  }
  if (item.status === "error") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="destructive">
            <X className="size-3" />
            失败
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="whitespace-pre-wrap break-words">
          {item.error}
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      <Clock className="size-3" />
      等待中
    </Badge>
  );
}

export function MdToXlsxView() {
  const [items, setItems] = useState<MdItem[]>([]);
  const [activeItem, setActiveItem] = useState<MdItem | null>(null);

  const itemsRef = useRef<MdItem[]>([]);
  const mutate = useCallback((fn: (prev: MdItem[]) => MdItem[]) => {
    const next = fn(itemsRef.current);
    itemsRef.current = next;
    setItems(next);
  }, []);

  const patchItem = useCallback(
    (id: string, patch: Partial<MdItem>) => {
      mutate((prev) =>
        prev.map((it) => (it.id === id ? { ...it, ...patch } : it)),
      );
    },
    [mutate],
  );

  const analyzeItem = useCallback(
    async (item: MdItem) => {
      patchItem(item.id, { status: "analyzing", error: undefined });
      try {
        const result = await analyzeMarkdown(item.path);
        patchItem(item.id, { status: "ready", result });
      } catch (e) {
        patchItem(item.id, { status: "error", error: String(e) });
      }
    },
    [patchItem],
  );

  const addFiles = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      const newItems: MdItem[] = paths.map((path) => ({
        id: crypto.randomUUID(),
        path,
        name: path.split(/[\\/]/).pop() ?? path,
        status: "queued",
      }));
      mutate((prev) => [...prev, ...newItems]);
      setActiveItem(null);
      for (const it of newItems) void analyzeItem(it);
    },
    [mutate, analyzeItem],
  );

  const { dragging } = useFileDrop(addFiles, {
    extensions: ["md"],
    errorMessage: "请拖入 .md 文件",
  });

  const removeItem = useCallback(
    (id: string) => {
      mutate((prev) => prev.filter((it) => it.id !== id));
      setActiveItem((cur) => (cur?.id === id ? null : cur));
    },
    [mutate],
  );

  const clearAll = useCallback(() => {
    mutate(() => []);
    setActiveItem(null);
  }, [mutate]);

  const retryItem = useCallback(
    (item: MdItem) => {
      patchItem(item.id, { status: "queued" });
      void analyzeItem(item);
    },
    [patchItem, analyzeItem],
  );

  async function pickMore() {
    const file = await open({
      multiple: true,
      filters: [{ name: "Markdown 文档", extensions: ["md"] }],
    });
    if (typeof file === "string") addFiles([file]);
    else if (Array.isArray(file) && file.length > 0) addFiles(file);
  }

  async function exportItem(item: MdItem) {
    if (!item.result || item.result.tableCount === 0) return;
    const base = item.name.replace(/\.md$/i, "") || "document";
    const target = await save({
      defaultPath: `${base}.xlsx`,
      filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }],
    });
    if (typeof target !== "string") return;
    try {
      const r = await exportMarkdownTables(item.path, target);
      toast.success("已导出", {
        description: `${r.tableCount} 张表格 · ${r.totalRows} 行`,
      });
    } catch (e) {
      toast.error("导出失败", { description: String(e) });
    }
  }

  async function exportAll() {
    const ready = itemsRef.current.filter(
      (it) => it.status === "ready" && it.result && it.result.tableCount > 0,
    );
    if (ready.length === 0) {
      toast.error("暂无可用文档", {
        description: "请先添加并解析至少一个含表格的 .md 文件",
      });
      return;
    }
    const dir = await open({
      directory: true,
      multiple: false,
      title: "选择导出目录",
    });
    if (typeof dir !== "string") return;
    let ok = 0;
    const used = new Set<string>();
    for (const it of ready) {
      const base = it.name.replace(/\.md$/i, "") || "document";
      let name = `${base}.xlsx`;
      let n = 2;
      while (used.has(name.toLowerCase())) name = `${base} (${n++}).xlsx`;
      used.add(name.toLowerCase());
      const target = await join(dir, name);
      try {
        await exportMarkdownTables(it.path, target);
        ok += 1;
      } catch (e) {
        toast.error(`导出失败: ${it.name}`, { description: String(e) });
      }
    }
    toast.success(`已导出 ${ok} 个文件`, { description: dir });
  }

  const previewing = Boolean(activeItem);
  if (previewing && activeItem) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col gap-3">
        {dragging ? (
          <DragOverlay title="松开以加入列表" hint="可追加多个 .md 文件" />
        ) : null}
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setActiveItem(null)}>
            <ArrowLeft />
            返回列表
          </Button>
        </div>
        <TablePreview
          tableCount={activeItem.result?.tableCount ?? 0}
          totalRows={activeItem.result?.totalRows ?? 0}
          tables={activeItem.result?.tables ?? []}
          className="flex-1"
        />
      </div>
    );
  }

  if (items.length > 1) {
    const readyCount = items.filter((it) => it.status === "ready").length;
    return (
      <div className="relative flex min-h-0 flex-1 flex-col gap-3">
        {dragging ? (
          <DragOverlay title="松开以加入列表" hint="可追加多个 .md 文件" />
        ) : null}

        <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-3 py-2 shadow-sm">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ListPlus className="size-4" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">Markdown 转 Excel</p>
            <p className="text-xs text-muted-foreground">
              已就绪 {readyCount} / {items.length} 个文件
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="icon-sm" onClick={clearAll}>
              <Trash2 />
            </Button>
            <Button variant="secondary" size="sm" onClick={pickMore}>
              <ListPlus />
              添加
            </Button>
            <Button variant="secondary" size="sm" onClick={exportAll}>
              <Download />
              全部导出
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-sm">
          <div className="flex h-full max-h-full flex-col">
            <div className="overflow-auto">
              <table className="w-full table-fixed text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">文件名</th>
                    <th className="w-[120px] px-3 py-2 font-medium">表格数</th>
                    <th className="w-[110px] px-3 py-2 font-medium">状态</th>
                    <th className="w-[150px] px-3 py-2 text-right font-medium">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr
                      key={item.id}
                      className="border-b transition-colors last:border-0 hover:bg-muted/40"
                    >
                      <td className="min-w-0 px-3 py-2">
                        <button
                          type="button"
                          disabled={item.status !== "ready"}
                          onClick={() => setActiveItem(item)}
                          className={cn(
                            "flex w-full min-w-0 items-center gap-2 text-left",
                            item.status === "ready"
                              ? "cursor-pointer hover:underline"
                              : "cursor-default",
                          )}
                        >
                          <span
                            className={cn(
                              "flex size-6 shrink-0 items-center justify-center rounded-md",
                              item.status === "ready"
                                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                : "bg-muted text-muted-foreground",
                            )}
                          >
                            <FileText className="size-3.5" />
                          </span>
                          <span className="truncate text-foreground">
                            {item.name}
                          </span>
                        </button>
                      </td>
                      <td className="px-3 py-2 text-xs tabular-nums text-muted-foreground">
                        {item.result
                          ? `${item.result.tableCount} 张 / ${item.result.totalRows} 行`
                          : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge item={item} />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          {item.status === "ready" &&
                          item.result &&
                          item.result.tableCount > 0 ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => exportItem(item)}
                                >
                                  <Download />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>导出 Excel</TooltipContent>
                            </Tooltip>
                          ) : null}
                          {item.status === "error" ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => retryItem(item)}
                                >
                                  <Check />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>重新解析</TooltipContent>
                            </Tooltip>
                          ) : null}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => removeItem(item.id)}
                              >
                                <X />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>从列表移除</TooltipContent>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (items.length === 1) {
    const item = items[0];
    return (
      <div className="relative flex min-h-0 flex-1 flex-col gap-3">
        {dragging ? (
          <DragOverlay title="松开以加入列表" hint="可追加多个 .md 文件" />
        ) : null}
        <div className="flex items-center gap-2 rounded-xl border bg-card px-3 py-2 shadow-sm">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Table2 className="size-4" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="truncate text-sm font-medium">{item.name}</p>
            <p className="text-xs text-muted-foreground">
              {item.result
                ? `检测到 ${item.result.tableCount} 张表格 · ${item.result.totalRows} 行数据`
                : "正在解析…"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge item={item} />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => removeItem(item.id)}
            >
              <X />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => exportItem(item)}
              disabled={
                item.status !== "ready" ||
                !item.result ||
                item.result.tableCount === 0
              }
            >
              <Download />
              导出 Excel
            </Button>
          </div>
        </div>
        <TablePreview
          tableCount={item.result?.tableCount ?? 0}
          totalRows={item.result?.totalRows ?? 0}
          tables={item.result?.tables ?? []}
          className="flex-1"
        />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-3">
      {dragging ? (
        <DragOverlay title="松开以加入列表" hint="可一次拖入多个 .md 文件" />
      ) : null}
      <DropZone
        onFiles={addFiles}
        multiple
        className="flex-1"
        extensions={["md"]}
        filterLabel="Markdown 文档"
        title="将 Markdown 文件拖到窗口任意位置"
        subtitle="或点击选择文件"
      />
    </div>
  );
}
