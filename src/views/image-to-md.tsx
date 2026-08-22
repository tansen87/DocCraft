import { useCallback, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Check,
  Clock,
  Download,
  FileImage,
  ListPlus,
  Loader2,
  Play,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { DragOverlay } from "@/components/pdf2md/drag-overlay";
import { DropZone } from "@/components/pdf2md/drop-zone";
import { formatDuration, PreviewPane } from "@/components/pdf2md/preview-pane";
import { StatusBar } from "@/components/pdf2md/status-bar";
import { useFileDrop } from "@/components/pdf2md/use-pdf-drop";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useI18n } from "@/i18n";
import { ensureMaxConcurrent } from "@/lib/concurrency";
import { exportMarkdown, ocrImageToMd } from "@/lib/ipc";
import type {
  ActivityProgress,
  OcrImageResult,
  StatusNotice,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg"];

type ImageStatus = "queued" | "converting" | "done" | "error";

interface ImageItem {
  id: string;
  path: string;
  name: string;
  status: ImageStatus;
  error?: string;
  result?: OcrImageResult;
}

function ItemStatusBadge({
  status,
  error,
}: {
  status: ImageStatus;
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

export function ImageToMdView() {
  const { t } = useI18n();
  const [items, setItems] = useState<ImageItem[]>([]);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportingAll, setExportingAll] = useState(false);
  /** In-flight recognition shown in the status bar. */
  const [activity, setActivity] = useState<ActivityProgress | null>(null);
  /** Item briefly highlighted after jumping from a notice chip. */
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const itemsRef = useRef<ImageItem[]>([]);
  const runningRef = useRef(false);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mutate = useCallback((fn: (prev: ImageItem[]) => ImageItem[]) => {
    const next = fn(itemsRef.current);
    itemsRef.current = next;
    setItems(next);
  }, []);

  const addFiles = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      mutate((prev) => {
        const known = new Set(prev.map((it) => it.path));
        const fresh = paths
          .filter((p) => !known.has(p))
          .map((path) => ({
            id: crypto.randomUUID(),
            path,
            name: path.split(/[\\/]/).pop() ?? path,
            status: "queued" as const,
          }));
        return [...prev, ...fresh];
      });
    },
    [mutate],
  );

  const removeItem = useCallback(
    (id: string) => {
      mutate((prev) => prev.filter((it) => it.id !== id));
    },
    [mutate],
  );

  const clearAll = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    setActivity(null);
    mutate(() => []);
  }, [mutate]);

  /**
   * Recognize every queued image through the configured OCR engine, bounded by
   * the user's global concurrency setting.
   */
  const start = useCallback(async () => {
    if (runningRef.current) return;
    const queue = itemsRef.current.filter(
      (it) => it.status === "queued" || it.status === "error",
    );
    if (queue.length === 0) return;

    runningRef.current = true;
    setRunning(true);

    const total = queue.length;
    let next = 0;
    let finished = 0;

    const worker = async () => {
      while (runningRef.current && next < total) {
        const job = queue[next++];
        mutate((prev) =>
          prev.map((it) =>
            it.id === job.id
              ? { ...it, status: "converting", error: undefined }
              : it,
          ),
        );
        try {
          const result = await ocrImageToMd(job.path);
          mutate((prev) =>
            prev.map((it) =>
              it.id === job.id ? { ...it, status: "done", result } : it,
            ),
          );
        } catch (e) {
          mutate((prev) =>
            prev.map((it) =>
              it.id === job.id
                ? { ...it, status: "error", error: String(e) }
                : it,
            ),
          );
        }
        finished += 1;
        setActivity({ phase: "imageOcr", current: finished, total });
      }
    };

    const concurrency = Math.min(await ensureMaxConcurrent(), total);
    await Promise.all(
      Array.from({ length: Math.max(concurrency, 1) }, () => worker()),
    );

    runningRef.current = false;
    setRunning(false);
    setActivity(null);
  }, [mutate]);

  const stop = useCallback(() => {
    if (!runningRef.current) return;
    runningRef.current = false;
    setRunning(false);
    setActivity(null);
  }, []);

  const retryFailed = useCallback(() => {
    mutate((prev) =>
      prev.map((it) =>
        it.status === "error"
          ? { ...it, status: "queued", error: undefined }
          : it,
      ),
    );
    void start();
  }, [mutate, start]);

  const retryRef = useRef(retryFailed);
  retryRef.current = retryFailed;

  /** Scroll an item's row into view (used by notice chips). */
  const scrollToItem = useCallback((index: number) => {
    const item = itemsRef.current[index - 1];
    if (!item) return;
    const el = rowRefs.current.get(item.id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightId(item.id);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightId(null), 1600);
  }, []);

  const doneItems = useMemo(
    () => items.filter((it) => it.status === "done" && it.result),
    [items],
  );
  const failedIndices = useMemo(
    () =>
      items
        .map((it, i) => (it.status === "error" ? i + 1 : 0))
        .filter((n) => n > 0),
    [items],
  );

  /**
   * Merged markdown of every recognized image. Each image is prefixed with an
   * `<!-- Image N -->` marker so the preview paginates + lazy-renders per
   * image exactly like the PDF workspace's `<!-- Page N -->` markers.
   */
  const mergedMarkdown = useMemo(
    () =>
      doneItems
        .map(
          (it, i) => `<!-- Image ${i + 1} -->\n\n${it.result!.markdown.trim()}`,
        )
        .filter((md) => md.replace(/<!--[^>]*-->/, "").trim())
        .join("\n\n---\n\n"),
    [doneItems],
  );
  const totalTimeMs = useMemo(
    () => doneItems.reduce((sum, it) => sum + (it.result?.durationMs ?? 0), 0),
    [doneItems],
  );

  async function exportItem(item: ImageItem): Promise<void> {
    if (!item.result) return;
    const base = item.name.replace(/\.(png|jpe?g)$/i, "") || "image";
    const target = await save({
      defaultPath: `${base}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (typeof target !== "string") return;
    try {
      await exportMarkdown(target, item.result.markdown);
      toast.success(t("toast.exported"), { description: target });
    } catch (e) {
      toast.error(t("toast.exportFailed"), { description: String(e) });
    }
  }

  async function exportMerged(): Promise<void> {
    if (!mergedMarkdown) return;
    const target = await save({
      defaultPath: "images.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (typeof target !== "string") return;
    setExporting(true);
    try {
      await exportMarkdown(target, mergedMarkdown);
      toast.success(t("toast.exported"), { description: target });
    } catch (e) {
      toast.error(t("toast.exportFailed"), { description: String(e) });
    } finally {
      setExporting(false);
    }
  }

  /**
   * Export every recognized image as its own `.md` file, named after the
   * source image, into a user-chosen directory.
   */
  async function exportEach(): Promise<void> {
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
        const base = it.name.replace(/\.(png|jpe?g)$/i, "") || "image";
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
      });
    } finally {
      setExportingAll(false);
    }
  }

  async function pickFiles(): Promise<void> {
    const picked = await open({
      multiple: true,
      filters: [{ name: t("filter.imageDocs"), extensions: IMAGE_EXTENSIONS }],
    });
    if (typeof picked === "string") addFiles([picked]);
    else if (Array.isArray(picked) && picked.length > 0) addFiles(picked);
  }

  const { dragging } = useFileDrop(addFiles, {
    extensions: IMAGE_EXTENSIONS,
    errorMessage: t("drop.imgInvalid"),
  });

  const notices = useMemo<StatusNotice[]>(() => {
    if (failedIndices.length === 0) return [];
    return [
      {
        id: "images-failed",
        level: "error",
        text: t("notice.failedImages", { count: failedIndices.length }),
        pages: failedIndices,
        onPageClick: scrollToItem,
        actions: [
          { label: t("status.actionRetry"), onClick: () => retryRef.current() },
        ],
      },
    ];
  }, [failedIndices, t, scrollToItem]);

  const total = items.length;
  const doneCount = doneItems.length;
  const hasQueued = items.some((it) => it.status === "queued");

  if (total === 0) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col gap-3">
        {dragging ? (
          <DragOverlay
            title={t("overlay.releaseToAdd")}
            hint={t("overlay.hintAddMany")}
          />
        ) : null}
        <DropZone
          onFiles={addFiles}
          multiple
          extensions={IMAGE_EXTENSIONS}
          filterLabel={t("filter.imageDocs")}
          title={t("drop.imgTitle")}
          supportText={t("drop.supported", {
            exts: ".png / .jpg",
            mode: t("drop.multiple"),
          })}
          className="flex-1"
        />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-3">
      {dragging ? (
        <DragOverlay
          title={t("overlay.releaseToAdd")}
          hint={t("overlay.hintAddMore")}
        />
      ) : null}

      {/* Summary / control bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-3 py-2 shadow-sm">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <FileImage className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">{t("img2md.title")}</p>
          <p className="text-xs text-muted-foreground">
            {running
              ? t("status.progressImageOcr", {
                  current: activity?.current ?? 0,
                  total: activity?.total ?? total,
                })
              : t("img2md.completed", { done: doneCount, total })}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={clearAll}
                disabled={running}
              >
                <Trash2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("batch.remove")}</TooltipContent>
          </Tooltip>
          <Button variant="secondary" size="sm" onClick={pickFiles}>
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
              onClick={() => void start()}
              disabled={!hasQueued}
            >
              <Play />
              {t("batch.start")}
            </Button>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void exportMerged()}
                disabled={exporting || doneCount === 0}
              >
                {exporting ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Download />
                )}
                {t("img2md.exportMerged")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("tooltip.exportMerged")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void exportEach()}
                disabled={exportingAll || doneCount === 0}
              >
                {exportingAll ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Download />
                )}
                {t("img2md.exportSingle")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("tooltip.exportSingle")}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Image list + merged markdown preview */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="min-h-0 overflow-hidden rounded-xl border bg-card shadow-sm">
          <div className="h-full overflow-y-auto p-2">
            {items.map((item, index) => (
              <div
                key={item.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(item.id, el);
                  else rowRefs.current.delete(item.id);
                }}
                className={cn(
                  "mb-2 flex items-center gap-3 rounded-lg border p-2 transition-all last:mb-0",
                  highlightId === item.id &&
                    "border-primary bg-primary/5 ring-2 ring-primary/40",
                )}
              >
                <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <img
                  src={convertFileSrc(item.path)}
                  alt={item.name}
                  className="size-10 shrink-0 rounded-md border bg-muted object-cover"
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {item.name}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {item.result ? formatDuration(item.result.durationMs) : "—"}
                </span>
                <ItemStatusBadge status={item.status} error={item.error} />
                <div className="flex shrink-0 items-center gap-1">
                  {item.status === "done" ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => void exportItem(item)}
                        >
                          <Download />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {t("tooltip.exportMarkdown")}
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  {item.status === "error" && !running ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => {
                            mutate((prev) =>
                              prev.map((it) =>
                                it.id === item.id
                                  ? {
                                      ...it,
                                      status: "queued",
                                      error: undefined,
                                    }
                                  : it,
                              ),
                            );
                            void start();
                          }}
                        >
                          <Play />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("tooltip.retry")}</TooltipContent>
                    </Tooltip>
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={running}
                        onClick={() => removeItem(item.id)}
                      >
                        <X />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t("tooltip.removeFromList")}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="min-h-0 min-w-0">
          {mergedMarkdown ? (
            <PreviewPane
              markdown={mergedMarkdown}
              processingTimeMs={totalTimeMs}
              onExport={exportMerged}
              className="h-full"
              showPageMarkers
            />
          ) : null}
        </div>
      </div>

      <div className="-mb-3">
        <StatusBar
          result={null}
          loading={false}
          hidePdfStats
          notices={notices}
          progress={activity}
        />
      </div>
    </div>
  );
}
