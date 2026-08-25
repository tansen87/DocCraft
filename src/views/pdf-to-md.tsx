import { useCallback, useEffect, useRef, useState } from "react";
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
  Play,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { ConvertWorkspace } from "@/components/pdf2md/convert-workspace";
import { DragOverlay } from "@/components/pdf2md/drag-overlay";
import { DropZone } from "@/components/pdf2md/drop-zone";
import { formatDuration } from "@/lib/format-duration";
import { usePdfDrop } from "@/components/pdf2md/use-pdf-drop";
import {
  convertWithOcr,
  CancelledError,
} from "@/components/pdf2md/render-pdf-pages";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  convertPdf,
  detectPdf,
  exportMarkdown,
  getAppSettings,
  revealExport,
} from "@/lib/ipc";
import { ensureMaxConcurrent } from "@/lib/concurrency";
import { setViewTask } from "@/lib/global-task";
import { useI18n } from "@/i18n";
import type { ConvertResult } from "@/lib/types";
import { cn } from "@/lib/utils";

type BatchStatus = "queued" | "converting" | "done" | "error";

interface BatchItem {
  id: string;
  path: string;
  name: string;
  status: BatchStatus;
  error?: string;
  result?: ConvertResult | null;
}

function StatusBadge({
  status,
  error,
}: {
  status: BatchStatus;
  error?: string;
}) {
  const { t } = useI18n();
  if (status === "converting") {
    return (
      <Badge className="border-sky-500/30 bg-sky-500/10 text-sky-600 dark:border-sky-500/40 dark:text-sky-400">
        <Loader2 className="size-3 animate-spin" />
        {t("status.converting")}
      </Badge>
    );
  }
  if (status === "done") {
    return (
      <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:border-emerald-500/40 dark:text-emerald-400">
        <Check className="size-3" />
        {t("status.done")}
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="destructive">
            <X className="size-3" />
            {t("status.failed")}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="whitespace-pre-wrap break-words">
          {error}
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      <Clock className="size-3" />
      {t("status.queued")}
    </Badge>
  );
}

export function BatchView() {
  const { t } = useI18n();
  const [items, setItems] = useState<BatchItem[]>([]);
  const [activeItem, setActiveItem] = useState<BatchItem | null>(null);
  const [running, setRunning] = useState(false);
  const [concurrency, setConcurrency] = useState(1);
  const [exportingIds, setExportingIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [exportingAll, setExportingAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ensureMaxConcurrent().then((n) => {
      if (!cancelled) setConcurrency(n);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const itemsRef = useRef<BatchItem[]>([]);
  const queueRef = useRef<{ id: string; path: string }[]>([]);
  const activeRef = useRef(0);
  const runningRef = useRef(false);
  const cancelRef = useRef(new Set<string>());
  const waitersRef = useRef<(() => void)[]>([]);

  const mutate = useCallback((fn: (prev: BatchItem[]) => BatchItem[]) => {
    const next = fn(itemsRef.current);
    itemsRef.current = next;
    setItems(next);
  }, []);

  const patchItem = useCallback(
    (id: string, patch: Partial<BatchItem>) => {
      mutate((prev) =>
        prev.map((it) => (it.id === id ? { ...it, ...patch } : it)),
      );
    },
    [mutate],
  );

  const wake = useCallback(() => {
    const ws = waitersRef.current;
    waitersRef.current = [];
    ws.forEach((w) => w());
  }, []);

  const runJob = useCallback(
    async (job: { id: string; path: string }) => {
      activeRef.current += 1;
      const isCancelled = () => cancelRef.current.has(job.id);
      patchItem(job.id, { status: "converting" });
      try {
        if (isCancelled()) throw new CancelledError();
        let result: ConvertResult;
        const det = await detectPdf(job.path);
        const needOcr = det.pagesNeedingOcr;
        // Route by the OCR toggle: when enabled the backend also OCRs pages
        // whose local text extraction came up empty (image pages detection may
        // miss).
        const settings = await getAppSettings();
        const isForce =
          settings.ocrMode === "forceLocal" || settings.ocrMode === "forceAi";
        const ocrPages = isForce
          ? Array.from({ length: det.pageCount }, (_, i) => i + 1)
          : needOcr;
        result =
          settings.ocrMode !== "disabled"
            ? await convertWithOcr(job.path, ocrPages, undefined, isCancelled)
            : await convertPdf(job.path);
        if (isCancelled()) throw new CancelledError();
        patchItem(job.id, { status: "done", result });
      } catch (e) {
        if (isCancelled() || e instanceof CancelledError) {
          // Cancelled - back to the queue as a plain unconverted item.
          patchItem(job.id, { status: "queued", error: undefined });
        } else {
          patchItem(job.id, { status: "error", error: String(e) });
        }
      } finally {
        cancelRef.current.delete(job.id);
        activeRef.current -= 1;
        if (queueRef.current.length === 0 && activeRef.current === 0) {
          runningRef.current = false;
          setRunning(false);
          wake();
        }
      }
    },
    [patchItem, wake],
  );

  const worker = useCallback(async () => {
    while (runningRef.current) {
      const job = queueRef.current.shift();
      if (!job) {
        await new Promise<void>((r) => waitersRef.current.push(r));
        continue;
      }
      await runJob(job);
    }
  }, [runJob]);

  const start = useCallback(() => {
    if (runningRef.current || queueRef.current.length === 0) return;
    runningRef.current = true;
    setRunning(true);
    for (let i = 0; i < concurrency; i += 1) void worker();
  }, [worker, concurrency]);

  // Report batch progress to the header's global task indicator.
  useEffect(() => {
    if (!running) {
      setViewTask("pdftomd", null);
      return;
    }
    const done = items.filter((it) => it.status === "done").length;
    setViewTask("pdftomd", `${Math.min(done, items.length)}/${items.length}`);
  }, [running, items]);

  const stop = useCallback(() => {
    if (!runningRef.current) return;
    runningRef.current = false;
    // Full cancel: abort in-flight conversions and keep every unfinished file
    // resumable - pressing Start picks up exactly where things stopped.
    for (const it of itemsRef.current) {
      if (it.status !== "converting") continue;
      cancelRef.current.add(it.id);
      if (!queueRef.current.some((j) => j.id === it.id)) {
        queueRef.current.push({ id: it.id, path: it.path });
      }
    }
    setRunning(false);
    wake();
  }, [wake]);

  /** Cancel one converting file - it goes back to a plain queued row that
   * will NOT restart with the pool (explicit retry required). */
  const cancelItem = useCallback((id: string) => {
    queueRef.current = queueRef.current.filter((j) => j.id !== id);
    cancelRef.current.add(id);
  }, []);

  const addFiles = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      const newItems: BatchItem[] = paths.map((path) => ({
        id: crypto.randomUUID(),
        path,
        name: path.split(/[\\/]/).pop() ?? path,
        status: "queued",
      }));
      const all = [...itemsRef.current, ...newItems];
      mutate(() => all);
      for (const it of newItems)
        queueRef.current.push({ id: it.id, path: it.path });
      setActiveItem(null);
      if (runningRef.current) {
        // 若批量池正空闲等待（队列已清空且无任务在执行），
        // 停掉池子，让新文件保持“等待中”，由用户点击“开始”再转换。
        if (
          queueRef.current.length === newItems.length &&
          activeRef.current === 0
        ) {
          runningRef.current = false;
          setRunning(false);
          wake();
        }
      }
    },
    [mutate, wake],
  );

  const { dragging, containerRef } = usePdfDrop(addFiles);

  const removeItem = useCallback(
    (id: string) => {
      mutate((prev) => prev.filter((it) => it.id !== id));
      queueRef.current = queueRef.current.filter((j) => j.id !== id);
      setActiveItem((cur) => (cur?.id === id ? null : cur));
    },
    [mutate],
  );

  const retryItem = useCallback(
    (item: BatchItem) => {
      mutate((prev) =>
        prev.map((it) =>
          it.id === item.id
            ? { ...it, status: "queued", error: undefined, result: undefined }
            : it,
        ),
      );
      queueRef.current = queueRef.current.filter((j) => j.id !== item.id);
      queueRef.current.push({ id: item.id, path: item.path });
      if (runningRef.current) wake();
      else start();
    },
    [mutate, start, wake],
  );

  const clearAll = useCallback(() => {
    stop();
    mutate(() => []);
    queueRef.current = [];
    setActiveItem(null);
  }, [mutate, stop]);

  const handleConverted = useCallback(
    (id: string, result: ConvertResult) => {
      patchItem(id, { status: "done", result });
      queueRef.current = queueRef.current.filter((j) => j.id !== id);
    },
    [patchItem],
  );

  async function pickMore() {
    const file = await open({
      multiple: true,
      filters: [{ name: t("filter.pdfDocs"), extensions: ["pdf"] }],
    });
    if (typeof file === "string") addFiles([file]);
    else if (Array.isArray(file) && file.length > 0) addFiles(file);
  }

  async function exportItem(item: BatchItem): Promise<void> {
    if (!item.result) return;
    setExportingIds((prev) => new Set(prev).add(item.id));
    try {
      const base = item.name.replace(/\.pdf$/i, "") || "document";
      const target = await save({
        defaultPath: `${base}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (typeof target !== "string") return;
      await exportMarkdown(target, item.result.markdown);
      toast.success(t("toast.exported"), {
        description: target,
        action: {
          label: t("action.openFolder"),
          onClick: () => void revealExport(target),
        },
      });
    } catch (e) {
      toast.error(t("toast.exportFailed"), { description: String(e) });
    } finally {
      setExportingIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  }

  async function exportAll(): Promise<void> {
    const done = itemsRef.current.filter(
      (it) => it.status === "done" && it.result,
    );
    if (done.length === 0) {
      toast.error(t("toast.noCompletedDocs"), {
        description: t("toast.noCompletedDocsDesc"),
      });
      return;
    }
    const dir = await open({
      directory: true,
      multiple: false,
      title: t("dialog.exportDir"),
    });
    if (typeof dir !== "string") return;
    setExportingAll(true);
    try {
      let ok = 0;
      const used = new Set<string>();
      for (const it of done) {
        const base = it.name.replace(/\.pdf$/i, "") || "document";
        let name = `${base}.md`;
        let n = 2;
        while (used.has(name.toLowerCase())) name = `${base} (${n++}).md`;
        used.add(name.toLowerCase());
        const target = await join(dir, name);
        try {
          await exportMarkdown(target, it.result!.markdown);
          ok += 1;
        } catch (e) {
          toast.error(t("toast.exportFailedFile", { name: it.name }), {
            description: String(e),
          });
        }
      }
      toast.success(t("toast.exportedCount", { count: ok }), {
        description: dir,
        action: {
          label: t("action.openFolder"),
          onClick: () => void revealExport(dir),
        },
      });
    } finally {
      setExportingAll(false);
    }
  }

  const total = items.length;
  const doneCount = items.filter((it) => it.status === "done").length;
  const convertingCount = items.filter(
    (it) => it.status === "converting",
  ).length;
  const hasQueued = items.some((it) => it.status === "queued");

  const view = activeItem ?? (items.length === 1 ? items[0] : null);
  const previewing = Boolean(activeItem);

  if (view) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col gap-3">
        {dragging ? (
          <DragOverlay
            title={t("overlay.releaseToAdd")}
            hint={t("overlay.hintAddMore")}
          />
        ) : null}

        {previewing ? (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActiveItem(null)}
            >
              <ArrowLeft />
              {t("backToList")}
            </Button>
          </div>
        ) : null}

        <ConvertWorkspace
          key={view.id}
          filePath={view.path}
          fileName={view.name}
          initialResult={view.result ?? undefined}
          onConverted={(r) => handleConverted(view.id, r)}
          onClear={previewing ? () => setActiveItem(null) : clearAll}
        />
      </div>
    );
  }

  if (total > 1) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col gap-3">
        {dragging ? (
          <DragOverlay
            title={t("overlay.releaseToAdd")}
            hint={t("overlay.hintAddMore")}
          />
        ) : null}

        <div className="flex flex-wrap items-center gap-3 rounded-xl glass-panel px-3 py-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileText className="size-4" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">{t("batch.title")}</p>
            <p
              className={cn(
                "text-xs",
                convertingCount > 0
                  ? "text-sky-600 dark:text-sky-400"
                  : "text-muted-foreground",
              )}
            >
              {convertingCount > 0
                ? t("batch.converting", {
                    active: convertingCount,
                    limit: concurrency,
                  })
                : ""}
              {t("batch.completed", { done: doneCount, total })}
              {total > doneCount
                ? t("batch.concurrency", { limit: concurrency })
                : ""}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={clearAll}
                  disabled={total === 0}
                >
                  <Trash2 />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("batch.remove")}</TooltipContent>
            </Tooltip>
            <Button variant="secondary" size="sm" onClick={pickMore}>
              <ListPlus />
              {t("batch.add")}
            </Button>
            {running ? (
              <Button size="sm" onClick={stop}>
                <Square />
                {t("batch.stop")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={start}
                disabled={!hasQueued}
              >
                <Play />
                {t("batch.start")}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void exportAll()}
              disabled={exportingAll}
            >
              {exportingAll ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Download />
              )}
              {t("batch.exportAll")}
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden rounded-xl glass-panel">
          <div className="flex h-full max-h-full flex-col">
            <div className="overflow-auto">
              <table className="w-full table-fixed text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">
                      {t("table.fileName")}
                    </th>
                    <th className="w-[100px] px-3 py-2 font-medium">
                      {t("table.status")}
                    </th>
                    <th className="w-[90px] px-3 py-2 font-medium">
                      {t("table.time")}
                    </th>
                    <th className="w-[150px] px-3 py-2 text-right font-medium">
                      {t("table.actions")}
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
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="block min-w-0">
                              <button
                                type="button"
                                disabled={item.status !== "done"}
                                onClick={() => setActiveItem(item)}
                                className={cn(
                                  "flex w-full min-w-0 items-center gap-2 text-left",
                                  item.status === "done"
                                    ? "cursor-pointer hover:underline"
                                    : "cursor-default",
                                )}
                              >
                                <span
                                  className={cn(
                                    "flex size-6 shrink-0 items-center justify-center rounded-md",
                                    item.status === "done"
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
                            </span>
                          </TooltipTrigger>
                        </Tooltip>
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={item.status} error={item.error} />
                      </td>
                      <td className="px-3 py-2 text-xs tabular-nums text-muted-foreground">
                        {item.result
                          ? formatDuration(item.result.processingTimeMs)
                          : ""}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          {item.status === "done" ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => void exportItem(item)}
                                  disabled={exportingIds.has(item.id)}
                                >
                                  {exportingIds.has(item.id) ? (
                                    <Loader2 className="animate-spin" />
                                  ) : (
                                    <Download />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {t("tooltip.exportMarkdown")}
                              </TooltipContent>
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
                                  <Play />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {t("tooltip.retry")}
                              </TooltipContent>
                            </Tooltip>
                          ) : null}
                          {item.status === "converting" ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => cancelItem(item.id)}
                                >
                                  <Square />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {t("batch.cancel")}
                              </TooltipContent>
                            </Tooltip>
                          ) : (
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
                              <TooltipContent>
                                {t("tooltip.removeFromList")}
                              </TooltipContent>
                            </Tooltip>
                          )}
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

  return (
    <div
      ref={containerRef}
      className="relative flex min-h-0 flex-1 flex-col gap-3"
    >
      {dragging ? (
        <DragOverlay
          title={t("overlay.releaseToAdd")}
          hint={t("overlay.hintAddMany")}
        />
      ) : null}

      <DropZone onFiles={addFiles} multiple className="flex-1" />
    </div>
  );
}
