import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useI18n } from "@/i18n";
import { checkForUpdate } from "@/lib/ipc";
import type { UpdateInfo } from "@/lib/types";

/** Page the "update" button navigates to. */
const RELEASE_PAGE_URL =
  "https://github.com/tansen87/DocCraft/releases/latest/";

/** Startup check runs at most once per session (remounts never re-query). */
let cachedCheck: Promise<UpdateInfo | null> | null = null;

function updateOnce(): Promise<UpdateInfo | null> {
  if (!cachedCheck) {
    // Any failure (offline, no release published yet) degrades to "none".
    cachedCheck = checkForUpdate().catch(() => null);
  }
  return cachedCheck;
}

/**
 * Right-side header actions, rendered to the left of the language toggle:
 * the manual update check and the non-blocking "new version" badge when a
 * newer release is known. Both open a dialog showing the release notes as
 * markdown, with an update button pointing at the releases page.
 */
export function HeaderActions() {
  const { t } = useI18n();
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void updateOnce().then((info) => {
      if (alive && info) setUpdate(info);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function manualCheck() {
    setChecking(true);
    try {
      const info = await checkForUpdate();
      if (info) {
        // Sync the startup cache so the badge reflects this result too.
        cachedCheck = Promise.resolve(info);
        setUpdate(info);
        setDialogOpen(true);
      } else {
        toast.info(t("update.upToDate"));
      }
    } catch (e) {
      toast.error(t("update.checkFailed"), { description: String(e) });
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      {update ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 rounded-full border-amber-500/40 px-2.5 text-xs text-amber-600 dark:text-amber-400"
              onClick={() => setDialogOpen(true)}
            >
              <ArrowUpCircle className="size-3.5" />
              {t("update.available", { version: update.version })}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("update.tooltip")}</TooltipContent>
        </Tooltip>
      ) : null}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            disabled={checking}
            onClick={() => void manualCheck()}
          >
            <RefreshCw
              className={checking ? "size-4 animate-spin" : "size-4"}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("update.check")}</TooltipContent>
      </Tooltip>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-xl">
          {update ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {t("update.available", { version: update.version })}
                </DialogTitle>
                {update.title ? (
                  <DialogDescription>{update.title}</DialogDescription>
                ) : null}
              </DialogHeader>

              <ScrollArea className="[&>[data-slot=scroll-area-viewport]]:max-h-[50vh]">
                <div className="markdown-body min-w-0 pr-2 text-sm">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {update.notes || t("update.notesEmpty")}
                  </ReactMarkdown>
                </div>
              </ScrollArea>

              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  {t("update.later")}
                </Button>
                <Button
                  onClick={() => void openUrl(update.url || RELEASE_PAGE_URL)}
                >
                  {t("update.updateNow")}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
