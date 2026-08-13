import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { toast } from "sonner";

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
          else toast.error("不支持的文件", { description: errorMessage });
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
  }, [onFiles, extensions, errorMessage]);

  return { dragging };
}

export function usePdfDrop(onFiles: (paths: string[]) => void) {
  return useFileDrop(onFiles, {
    extensions: ["pdf"],
    errorMessage: "请拖入 .pdf 文件",
  });
}