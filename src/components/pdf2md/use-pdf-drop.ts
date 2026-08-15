import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { toast } from "sonner";

import { useI18n } from "@/i18n";

interface UseFileDropOptions {
  /** File extensions to accept, without a leading dot. */
  extensions: string[];
  /** Message shown when dropped files don't match `extensions`. */
  errorMessage: string;
}

export function useFileDrop(
  onFiles: (paths: string[]) => void,
  { extensions, errorMessage }: UseFileDropOptions,
) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let stopped = false;
    let unlisten: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const { type } = event.payload;
        if (type === "over" || type === "enter") setDragging(true);
        else if (type === "leave") setDragging(false);
        else if (type === "drop") {
          setDragging(false);
          const matched = event.payload.paths.filter((p) =>
            extensions.some((ext) => p.toLowerCase().endsWith(`.${ext}`)),
          );
          if (matched.length > 0) onFiles(matched);
          else
            toast.error(t("toast.unsupportedFile"), {
              description: errorMessage,
            });
        }
      })
      .then((fn) => {
        // If the effect has already been cleaned up (e.g. StrictMode
        // double-mount in dev), immediately unregister the listener,
        // otherwise the drop event fires more than once.
        if (stopped) fn();
        else unlisten = fn;
      });

    return () => {
      stopped = true;
      if (unlisten) unlisten();
    };
  }, [onFiles, extensions, errorMessage, t]);

  return { dragging };
}

export function usePdfDrop(onFiles: (paths: string[]) => void) {
  const { t } = useI18n();
  return useFileDrop(onFiles, {
    extensions: ["pdf"],
    errorMessage: t("drop.pdfInvalid"),
  });
}
