import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, CloudDownload, Loader2 } from "lucide-react";
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
import { cn } from "@/lib/utils";
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

/**
 * A manual check that lands while another check is in flight gets that check's
 * transient snapshot back, so it polls `get_update_state` until the phase
 * settles (or this window elapses) before reporting a result.
 */
const SETTLE_POLL_MS = 300;
const SETTLE_TIMEOUT_MS = 15_000;

/** `12.3 MB` for progress labels. */
function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Ring geometry: a 32px button, so the arc hugs the rounded square outline. */
const RING_RADIUS = 14;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Determinate download ring drawn around the icon button. Only rendered when
 * the server reported a total size - without one there is no percentage to
 * show, and the button falls back to the spinning loader instead.
 */
function DownloadRing({ percent }: { percent: number }) {
  const clamped = Math.min(100, Math.max(0, percent));
  const dash = (RING_CIRCUMFERENCE * clamped) / 100;
  return (
    <svg
      aria-hidden
      viewBox="0 0 32 32"
      className="pointer-events-none absolute inset-0 size-8"
    >
      {/* Start the arc at 12 o'clock; the SVG `transform` attribute avoids any
          CSS transform-origin ambiguity for SVG children. */}
      <g transform="rotate(-90 16 16)">
        <circle
          cx="16"
          cy="16"
          r={RING_RADIUS}
          className="fill-none stroke-current opacity-15"
          strokeWidth="2"
        />
        <circle
          cx="16"
          cy="16"
          r={RING_RADIUS}
          className="fill-none stroke-primary transition-[stroke-dashoffset] duration-300 ease-out"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE - dash}
        />
      </g>
    </svg>
  );
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
    // A check already in flight owns the button; the spinner is the feedback.
    if (checking) return;
    // Download / install running: reopen the progress dialog instead of
    // firing another check (the backend would ignore it anyway).
    if (running) {
      setDialogOpen(true);
      return;
    }
    // A known update reopens the dialog instead of re-querying GitHub.
    if (hasUpdate) {
      setDialogOpen(true);
      return;
    }
    setChecking(true);
    try {
      let next = await checkForUpdate(true);
      // The backend single-flights checks: clicking while the startup check is
      // still running hands back that check's *transient* snapshot
      // (`phase: "checking"`, no version) instead of an answer. Reporting it as
      // "up to date" is what made an available update show up seconds later.
      // Poll the state until the in-flight check settles.
      const deadline = Date.now() + SETTLE_TIMEOUT_MS;
      while (next.phase === "checking" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
        next = await getUpdateState();
      }
      setSnapshot(next);
      reportCheck(next);
    } catch (e) {
      toast.error(t("update.checkFailed"), { description: String(e) });
    } finally {
      setChecking(false);
    }
  }

  /** Report the outcome of a check whose snapshot has settled. */
  function reportCheck(next: UpdateSnapshot) {
    if (next.phase === "available") {
      setDialogOpen(true);
    } else if (next.phase === "error") {
      toast.error(t("update.checkFailed"), {
        description:
          next.errorKind === "noManifest"
            ? t("update.noManifest")
            : (next.error ?? undefined),
      });
    } else if (next.phase === "downloading" || next.phase === "installing") {
      // A download / install already owns the state (the check was refused
      // because the backend is busy) - show its progress, claim nothing.
      setDialogOpen(true);
    } else if (next.phase === "checking") {
      // Still in flight after the settle window - saying "up to date" here
      // would be a guess, and the wrong one whenever an update does exist.
      toast.info(t("update.checking"));
    } else if (next.phase === "skipped" && next.version) {
      // Also not "up to date": a newer version exists, the user just muted the
      // automatic reminder. An explicit check should say so.
      toast.info(t("update.skipped", { version: next.version }), {
        action: {
          label: t("update.viewGithub"),
          onClick: () => void openUrl(next.releaseUrl || RELEASE_PAGE_URL),
        },
      });
    } else {
      toast.info(t("update.upToDate"), {
        action: {
          label: t("update.viewGithub"),
          onClick: () => void openUrl(next.releaseUrl || RELEASE_PAGE_URL),
        },
      });
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
      ? Math.min(
          100,
          Math.round((snapshot.downloadedBytes / snapshot.totalBytes) * 100),
        )
      : null;

  /** In-flight states - the button shows motion instead of a dead grey face. */
  const inFlight = checking || running;
  /** Only a real download with a reported size gets the determinate ring. */
  const showRing = phase === "downloading" && percent !== null;
  /** Everything else in flight spins, since there is no percentage to draw. */
  const spinIcon = inFlight && !showRing;

  const tooltipText = running
    ? percent !== null
      ? t("update.downloading", { percent })
      : t("update.downloadingUnknown")
    : checking
      ? t("update.checking")
      : hasUpdate && version
        ? t("update.dotTooltip", { version })
        : t("update.check");

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "relative transition-opacity",
              checking && "opacity-80",
              inFlight && "cursor-progress",
            )}
            aria-busy={inFlight}
            aria-disabled={checking}
            onClick={() => void manualCheck()}
            aria-label={
              hasUpdate && version
                ? t("update.dotTooltip", { version })
                : t("update.check")
            }
          >
            {spinIcon ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CloudDownload className="size-4" />
            )}

            {/* Determinate download progress, drawn around the icon. */}
            {showRing ? <DownloadRing percent={percent ?? 0} /> : null}

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
        <TooltipContent>{tooltipText}</TooltipContent>
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
                variant="secondary"
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
