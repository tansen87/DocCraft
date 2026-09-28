import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, RefreshCw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useI18n } from "@/i18n";
import { useGlobalTasks } from "@/lib/global-task";
import {
  checkForUpdate,
  getUpdateState,
  onUpdateState,
  skipUpdateVersion,
  updateNow,
} from "@/lib/ipc";
import type { UpdateSnapshot } from "@/lib/types";

/** Fallback when a snapshot has no release URL yet. */
const RELEASE_PAGE_URL = "https://github.com/tansen87/DocCraft/releases/latest";

/** `12.3 MB` for progress labels. */
function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Right-side header actions: release check with a small green dot when a newer
 * version is published, plus the one-click "download & install" flow
 * (docs/design/00021_auto-download-install.md).
 *
 * The backend runs the startup check ~3s after launch and pushes snapshots over
 * `update://state`, so this component never triggers network work on the render
 * path - it subscribes and mirrors the snapshot. The update itself is started
 * explicitly by the user and executed entirely in Rust (signed package,
 * verified before install).
 */
export function HeaderActions() {
  const { t } = useI18n();
  const tasks = useGlobalTasks();
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null);
  const [checking, setChecking] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  /** Second-click confirmation while a workspace task is running. */
  const [armed, setArmed] = useState(false);

  // Initial value (covers the window between launch and the first event) plus
  // the live stream of snapshots.
  useEffect(() => {
    let alive = true;
    void getUpdateState()
      .then((state) => {
        if (alive) setSnapshot((prev) => prev ?? state);
      })
      .catch(() => {});
    const unlisten = onUpdateState((state) => setSnapshot(state));
    return () => {
      alive = false;
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Never keep the "armed" state once the running tasks are gone or the dialog
  // moved on.
  useEffect(() => {
    if (tasks.size === 0) setArmed(false);
  }, [tasks.size]);

  const version = snapshot?.version ?? null;
  const phase = snapshot?.phase ?? "idle";
  const hasUpdate = phase === "available" && version !== null;
  const running = phase === "downloading" || phase === "installing";
  const releaseUrl = snapshot?.releaseUrl || RELEASE_PAGE_URL;
  const busy = tasks.size > 0;

  async function manualCheck() {
    // A known update reopens the dialog instead of re-querying GitHub.
    if (hasUpdate) {
      setDialogOpen(true);
      return;
    }
    setChecking(true);
    try {
      const next = await checkForUpdate(true);
      setSnapshot(next);
      if (next.phase === "available") {
        setDialogOpen(true);
      } else if (next.phase === "error") {
        toast.error(t("update.checkFailed"), {
          description:
            next.errorKind === "noManifest"
              ? t("update.noManifest")
              : (next.error ?? undefined),
        });
      } else {
        toast.info(t("update.upToDate"), {
          action: {
            label: t("update.viewGithub"),
            onClick: () => void openUrl(next.releaseUrl || RELEASE_PAGE_URL),
          },
        });
      }
    } catch (e) {
      toast.error(t("update.checkFailed"), { description: String(e) });
    } finally {
      setChecking(false);
    }
  }

  /** Download + install. The app is replaced and restarted by the installer. */
  async function install() {
    // A running conversion would be killed by the restart - ask once.
    if (busy && !armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    try {
      await updateNow();
    } catch (e) {
      toast.error(t("update.installFailed"), { description: String(e) });
    }
  }

  async function skipVersion() {
    if (!version) return;
    try {
      const next = await skipUpdateVersion(version);
      setSnapshot(next);
      setDialogOpen(false);
      toast.success(t("update.skipped", { version }));
    } catch (e) {
      toast.error(t("toast.saveFailed"), { description: String(e) });
    }
  }

  const percent =
    snapshot && snapshot.totalBytes
      ? Math.min(100, Math.round((snapshot.downloadedBytes / snapshot.totalBytes) * 100))
      : null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="relative"
            disabled={checking}
            onClick={() => void manualCheck()}
            aria-label={
              hasUpdate && version
                ? t("update.dotTooltip", { version })
                : t("update.check")
            }
          >
            <RefreshCw
              className={checking || running ? "size-4 animate-spin" : "size-4"}
            />
            {hasUpdate ? (
              // Small green dot on the icon's top-right corner; the ring keeps
              // it readable over both themes and the glassmorphism backdrop.
              <span
                aria-hidden
                className="pointer-events-none absolute right-1.5 top-1.5 size-1.5 rounded-full bg-green-500 ring-2 ring-background"
              />
            ) : null}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {running
            ? percent !== null
              ? t("update.downloading", { percent })
              : t("update.downloadingUnknown")
            : hasUpdate && version
              ? t("update.dotTooltip", { version })
              : t("update.check")}
        </TooltipContent>
      </Tooltip>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {t("update.available", { version: version ?? "" })}
            </DialogTitle>
            <DialogDescription>
              {snapshot?.date
                ? t("update.publishedAt", { date: snapshot.date })
                : t("update.manualHint")}
            </DialogDescription>
          </DialogHeader>

          {running ? (
            <div className="space-y-2">
              <Progress value={percent ?? 0} className="h-1.5" />
              <p className="text-xs text-muted-foreground">
                {phase === "installing"
                  ? t("update.installing")
                  : snapshot && snapshot.totalBytes
                    ? t("update.downloadingWithSize", {
                        percent: percent ?? 0,
                        done: formatMb(snapshot.downloadedBytes),
                        total: formatMb(snapshot.totalBytes),
                      })
                    : t("update.downloadingUnknown")}
              </p>
            </div>
          ) : (
            <ScrollArea className="[&>[data-slot=scroll-area-viewport]]:max-h-[50vh]">
              <div className="markdown-body min-w-0 pr-2 text-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {snapshot?.notes || t("update.notesEmpty")}
                </ReactMarkdown>
              </div>
            </ScrollArea>
          )}

          {!snapshot?.autoInstall ? (
            <p className="flex items-start gap-2 rounded-lg bg-warning/10 p-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {t("update.noAutoInstall")}
            </p>
          ) : busy ? (
            <p className="flex items-start gap-2 rounded-lg bg-warning/10 p-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {t("update.busyWarning")}
            </p>
          ) : null}

          <DialogFooter className="sm:justify-between">
            <div className="flex gap-2">
              <Button
                variant="ghost"
                disabled={running}
                onClick={() => void skipVersion()}
              >
                {t("update.skipVersion")}
              </Button>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={running}
                onClick={() => setDialogOpen(false)}
              >
                {t("update.later")}
              </Button>
              <Button
                disabled={running}
                variant={busy ? "destructive" : "default"}
                onClick={() => void install()}
              >
                {snapshot?.autoInstall
                  ? busy && !armed
                    ? t("update.confirmInstall")
                    : t("update.installNow")
                  : t("update.manualDownload")}
              </Button>
              {!snapshot?.autoInstall ? (
                <Button
                  variant="ghost"
                  disabled={running}
                  onClick={() => void openUrl(releaseUrl)}
                >
                  {t("update.viewGithub")}
                </Button>
              ) : null}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
