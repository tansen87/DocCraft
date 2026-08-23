import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { emitTo, listen } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
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
  Columns3Cog,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { DragOverlay } from "@/components/pdf2md/drag-overlay";
import { DropZone } from "@/components/pdf2md/drop-zone";
import { formatDuration } from "@/lib/format-duration";
import { PreviewPane } from "@/components/pdf2md/preview-pane";
import { StatusBar } from "@/components/pdf2md/status-bar";
import { useFileDrop } from "@/components/pdf2md/use-pdf-drop";
import { ImageTableOverlay } from "@/components/image-table/image-table-overlay";
import { showSnipResultWindow } from "@/components/snip/snip-result-window";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { setViewTask } from "@/lib/global-task";
import { useI18n } from "@/i18n";
import { ensureMaxConcurrent } from "@/lib/concurrency";
import {
  cancelScreenshot,
  exportMarkdown,
  getAppSettings,
  ocrImageToMd,
  screenshotOcrRegion,
  revealExport,
} from "@/lib/ipc";
import type {
  ActivityProgress,
  MonitorSnapshot,
  OcrImageResult,
  ShotRegion,
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
  /** Inline thumbnail (data URL) for screenshot items without a real file yet. */
  thumbUrl?: string;
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
  /** A region-selection session is in progress (overlays open). */
  const snippingRef = useRef(false);
  /** In-flight recognition shown in the status bar. */
  const [activity, setActivity] = useState<ActivityProgress | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  /** Item whose markdown is shown in the preview pane (null = merged view). */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Image path currently being edited in the draw-table overlay. */
  const [drawTablePath, setDrawTablePath] = useState<string | null>(null);

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

  // Report recognition progress to the header's global task indicator.
  useEffect(() => {
    if (!running) {
      setViewTask("imgtomd", null);
      return;
    }
    if (activity?.total != null) {
      const current = activity.current ?? 0;
      setViewTask(
        "imgtomd",
        `${Math.min(current, activity.total)}/${activity.total}`,
      );
      return;
    }
    const done = items.filter((it) => it.status === "done").length;
    setViewTask("imgtomd", `${Math.min(done, items.length)}/${items.length}`);
  }, [running, activity, items]);

  /**
   * Recognize one captured screen region: insert a converting row, run the
   * backend snip OCR and merge the result. The saved screenshot copy becomes
   * the item path, so retry / export behave exactly like an imported file.
   */
  const recognizeShot = useCallback(
    async (region: ShotRegion) => {
      const id = crypto.randomUUID();
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const name = `screenshot-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;

      mutate((prev) => [
        ...prev,
        { id, path: "", name, status: "converting" as const },
      ]);
      setActivity({ phase: "imageOcr", current: 0, total: 1 });
      try {
        const result = await screenshotOcrRegion(region);
        mutate((prev) =>
          prev.map((it) =>
            it.id === id
              ? {
                  ...it,
                  path: result.savedPath ?? "",
                  thumbUrl: result.pngBase64
                    ? `data:image/png;base64,${result.pngBase64}`
                    : undefined,
                  status: "done" as const,
                  result,
                }
              : it,
          ),
        );
        // Focus the preview (and its Copy button) on the freshest shot.
        setSelectedId(id);

        // Post-recognition extras, both on by default and configurable in
        // Settings → Screenshot: auto-copy the text and show a popup. They
        // run independently so a clipboard failure never blocks the popup
        // (and an older backend missing the fields keeps defaults).
        const settings = await getAppSettings().catch(() => null);
        if ((settings?.snipAutoCopy ?? true) && result.markdown) {
          try {
            // Native clipboard write (no focus / user-gesture requirement —
            // the webview API gets rejected right after the snip restore).
            const { writeText } =
              await import("@tauri-apps/plugin-clipboard-manager");
            await writeText(result.markdown);
          } catch {
            /* clipboard unavailable */
          }
        }
        if (settings?.snipResultPopup ?? true) {
          void showSnipResultWindow(result.markdown).catch(() => {});
        }
      } catch (e) {
        mutate((prev) =>
          prev.map((it) =>
            it.id === id
              ? { ...it, status: "error" as const, error: String(e) }
              : it,
          ),
        );
        toast.error(t("toast.convertFailed"), { description: String(e) });
        // Safety net: if the OCR command failed before its own session-end
        // ran (e.g. IPC-level failure), make sure the main window comes back.
        try {
          await cancelScreenshot();
        } catch {
          /* best effort */
        }
      } finally {
        setActivity(null);
      }
    },
    [mutate, t],
  );

  /** Show the per-monitor overlay windows and wire up region selection events. */
  const showOverlay = useCallback(
    async (monitors: MonitorSnapshot[]) => {
      try {
        let unlistenSelected: (() => void) | null = null;
        let unlistenCancelled: (() => void) | null = null;
        let settled = false;

        // Overlay windows are reused across snips (hidden, not destroyed) so
        // the WebView cold start is paid only once per monitor.
        const hideOverlays = async () => {
          await Promise.allSettled(
            monitors.map(async (m) => {
              const win = await WebviewWindow.getByLabel(`snip-${m.id}`);
              await win?.hide();
            }),
          );
        };

        /**
         * Tear down the snip session UI. When a region *was* selected we must NOT
         * call `cancelScreenshot` — the follow-up `screenshot_ocr` command
         * consumes the cached snapshot and restores the main window itself;
         * cancelling here first would wipe the snapshot ("session expired").
         */
        const finish = async (restoreApp: boolean) => {
          unlistenSelected?.();
          unlistenCancelled?.();
          unlistenSelected = null;
          unlistenCancelled = null;
          cleanupStorage();
          await hideOverlays();
          if (restoreApp) {
            try {
              await cancelScreenshot();
            } catch {
              /* best effort */
            }
          }
          snippingRef.current = false;
        };

        const onSelected = async (region: ShotRegion) => {
          if (settled) return;
          settled = true;
          await finish(false);
          await recognizeShot(region);
        };
        const onCancelled = async () => {
          if (settled) return;
          settled = true;
          await finish(true);
        };

        const cleanupStorage = () =>
          monitors.forEach((m) =>
            localStorage.removeItem(`doccraft-snip-${m.id}`),
          );

        // Stash snapshots for the overlay windows before showing them.
        for (const m of monitors) {
          localStorage.setItem(`doccraft-snip-${m.id}`, JSON.stringify(m));
        }

        [unlistenSelected, unlistenCancelled] = await Promise.all([
          listen<ShotRegion>(
            "snip:selected",
            (e) => void onSelected(e.payload),
          ),
          listen<never>("snip:cancelled", () => void onCancelled()),
        ]);

        for (const m of monitors) {
          const label = `snip-${m.id}`;
          const existing = await WebviewWindow.getByLabel(label);
          if (existing) {
            // Reuse path: refresh content while hidden; the overlay reveals
            // itself once the new snapshot image has finished loading.
            await existing.setPosition(new PhysicalPosition(m.x, m.y));
            await existing.setSize(new PhysicalSize(m.width, m.height));
            await emitTo(label, "snip:meta", m);
          } else {
            const win = new WebviewWindow(label, {
              x: m.x,
              y: m.y,
              width: m.width,
              height: m.height,
              url: "index.html",
              decorations: false,
              transparent: true,
              alwaysOnTop: true,
              skipTaskbar: true,
              resizable: false,
              maximizable: false,
              minimizable: false,
              shadow: false,
              visible: false,
            });
            // Constructor options are logical units — enforce exact physical
            // placement so the overlay covers its monitor pixel-for-pixel.
            void win.once("tauri://created", async () => {
              await win.setPosition(new PhysicalPosition(m.x, m.y));
              await win.setSize(new PhysicalSize(m.width, m.height));
              await emitTo(label, "snip:meta", m).catch(() => {});
            });
            void win.once("tauri://error", (e) => {
              toast.error(t("snip.beginFailed"), {
                description: String(e.payload),
              });
              void onCancelled();
            });
          }
        }
      } catch (e) {
        // Any synchronous error during set-up — restore the main window.
        try {
          await cancelScreenshot();
        } catch {
          /* best effort */
        }
        snippingRef.current = false;
        throw e; // re-throw so the caller (startSnipWithMonitors) can also react.
      }
    },
    [recognizeShot, t],
  );

  /** Same as `startSnip` but receives pre-captured monitors (for `snip:ready`). */
  const startSnipWithMonitors = useCallback(
    async (monitors: MonitorSnapshot[]) => {
      try {
        const settings = await getAppSettings();
        if (settings.ocrMode === "disabled") {
          toast.error(t("snip.disabledTitle"), {
            description: t("snip.disabledDesc"),
          });
          return;
        }
      } catch {}
      snippingRef.current = true;
      try {
        await showOverlay(monitors);
      } catch (e) {
        try {
          await cancelScreenshot();
        } catch {
          /* best effort */
        }
        snippingRef.current = false;
        toast.error(t("snip.beginFailed"), { description: String(e) });
      }
    },
    [showOverlay, t],
  );

  // Listen for `snip:ready` from the backend hotkey handler (no IPC round-trip).
  const startSnipWithMonitorsRef = useRef(startSnipWithMonitors);
  startSnipWithMonitorsRef.current = startSnipWithMonitors;
  useEffect(() => {
    const unlisten = listen<MonitorSnapshot[]>(
      "snip:ready",
      (e) => void startSnipWithMonitorsRef.current(e.payload),
    );
    const unlistenErr = listen<string>("snip:error", (e) => {
      void cancelScreenshot().catch(() => {});
      toast.error(t("snip.beginFailed"), { description: e.payload });
    });
    return () => {
      void unlisten.then((fn) => fn());
      void unlistenErr.then((fn) => fn());
    };
  }, [t]);

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
      toast.success(t("toast.exported"), {
        description: target,
        action: {
          label: t("action.openFolder"),
          onClick: () => void revealExport(target),
        },
      });
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
        action: {
          label: t("action.openFolder"),
          onClick: () => void revealExport(dir),
        },
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

  const { dragging, containerRef } = useFileDrop(addFiles, {
    extensions: IMAGE_EXTENSIONS,
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
  /** The item selected for individual preview (falls back to merged view). */
  const previewItem =
    items.find(
      (it) => it.id === selectedId && it.status === "done" && it.result,
    ) ?? null;

  /**
   * Picker in the preview header: choose the merged document or any single
   * image's markdown. Copy / export for whichever is shown live right here.
   */
  const previewToolbar = (
    <Select
      value={previewItem?.id ?? "__merged__"}
      onValueChange={(v) => setSelectedId(v === "__merged__" ? null : v)}
    >
      <SelectTrigger
        size="sm"
        className="shrink-0 max-w-44"
        aria-label={t("img2md.previewScope")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__merged__">{t("img2md.previewMerged")}</SelectItem>
        {doneItems.map((it) => (
          <SelectItem key={it.id} value={it.id}>
            {it.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

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
    <div
      ref={containerRef}
      className="relative flex min-h-0 flex-1 flex-col gap-3"
    >
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
                  "mb-2 flex cursor-pointer items-center gap-3 rounded-lg border p-2 transition-all last:mb-0",
                  highlightId === item.id &&
                    "border-primary bg-primary/5 ring-2 ring-primary/40",
                  highlightId !== item.id &&
                    selectedId === item.id &&
                    "border-primary bg-primary/5",
                )}
                onClick={() =>
                  setSelectedId(
                    item.status === "done" && selectedId !== item.id
                      ? item.id
                      : null,
                  )
                }
              >
                <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                {item.thumbUrl || item.path ? (
                  <img
                    src={item.thumbUrl ?? convertFileSrc(item.path)}
                    alt={item.name}
                    className="size-10 shrink-0 rounded-md border bg-muted object-cover"
                  />
                ) : (
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted">
                    <FileImage className="size-4 text-muted-foreground" />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-sm">
                  {item.name}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {item.result ? formatDuration(item.result.durationMs) : ""}
                </span>
                <ItemStatusBadge status={item.status} error={item.error} />
                <div className="flex shrink-0 items-center gap-1">
                  {item.path ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={running}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDrawTablePath(item.path);
                          }}
                        >
                          <Columns3Cog />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("tooltip.drawTable")}</TooltipContent>
                    </Tooltip>
                  ) : null}
                  {item.status === "error" && !running ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={(e) => {
                            e.stopPropagation();
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
                        onClick={(e) => {
                          e.stopPropagation();
                          removeItem(item.id);
                        }}
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
          {previewItem ? (
            <PreviewPane
              key={previewItem.id}
              markdown={previewItem.result!.markdown}
              processingTimeMs={previewItem.result!.durationMs}
              onExport={() => exportItem(previewItem)}
              className="h-full"
              toolbar={previewToolbar}
            />
          ) : mergedMarkdown ? (
            <PreviewPane
              markdown={mergedMarkdown}
              processingTimeMs={totalTimeMs}
              onExport={exportMerged}
              className="h-full"
              showPageMarkers
              toolbar={previewToolbar}
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

      {drawTablePath ? (
        <ImageTableOverlay
          imagePath={drawTablePath}
          onClose={() => setDrawTablePath(null)}
          onResult={(result) => {
            // Add the extracted table markdown as a new item result,
            // carrying over the real engine + duration from the backend.
            const id = crypto.randomUUID();
            mutate((prev) => [
              ...prev,
              {
                id,
                path: drawTablePath,
                name: `Table_from_${drawTablePath.split(/[/\\]/).pop() ?? "image"}`,
                status: "done",
                result: {
                  markdown: result.markdown,
                  engine: result.engine,
                  durationMs: result.durationMs,
                },
              },
            ]);
            // Focus the preview on the freshly extracted table.
            setSelectedId(id);
          }}
        />
      ) : null}
    </div>
  );
}
