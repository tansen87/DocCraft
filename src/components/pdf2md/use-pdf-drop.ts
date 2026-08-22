import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

interface UseFileDropOptions {
  /** File extensions to accept, without a leading dot. */
  extensions: string[];
  /**
   * Optional external ref on the view's root container.  When provided, the
   * hook uses it instead of creating an internal one.
   */
  containerRef?: RefObject<HTMLDivElement | null>;
}

export function useFileDrop(
  onFiles: (paths: string[]) => void,
  { extensions, containerRef: externalRef }: UseFileDropOptions,
) {
  const [dragging, setDragging] = useState(false);
  const internalRef = useRef<HTMLDivElement>(null);
  const containerRef = externalRef ?? internalRef;

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
        }
      })
      .then((fn) => {
        if (stopped) fn();
        else unlisten = fn;
      });

    return () => {
      stopped = true;
      if (unlisten) unlisten();
    };
  }, [onFiles, extensions]);

  return { dragging, containerRef };
}

export function usePdfDrop(onFiles: (paths: string[]) => void) {
  return useFileDrop(onFiles, {
    extensions: ["pdf"],
  });
}
