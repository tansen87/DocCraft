import { useCallback, useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { useI18n } from "@/i18n";

/**
 * Fullscreen region-selection overlay shown inside a per-monitor snip window
 * (label `snip-<monitorId>`). The frozen monitor snapshot is displayed as the
 * background; the user drags a rectangle and the selection is reported to the
 * main window in physical pixels via the `snip:selected` event.
 */
export function SnipOverlay() {
  const { t } = useI18n();
  const [meta, setMeta] = useState<{
    dataUrl: string;
    width: number;
    height: number;
    scaleFactor: number;
  } | null>(null);
  /** Drag state in CSS pixels: selection start + current point. */
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<null | {
    left: number;
    top: number;
    width: number;
    height: number;
  }>(null);

  const close = useCallback(() => {
    void getCurrentWebviewWindow().close();
  }, []);

  const cancel = useCallback(() => {
    void emit("snip:cancelled");
    close();
  }, [close]);

  const confirm = useCallback(
    (r: { left: number; top: number; width: number; height: number }) => {
      const metaNow = meta;
      if (!metaNow) return;
      // CSS px → physical px relative to this monitor's top-left corner.
      void emit("snip:selected", {
        monitorId: Number(
          getCurrentWebviewWindow().label.replace(/^snip-/, ""),
        ),
        x: Math.round(r.left * metaNow.scaleFactor),
        y: Math.round(r.top * metaNow.scaleFactor),
        width: Math.round(r.width * metaNow.scaleFactor),
        height: Math.round(r.height * metaNow.scaleFactor),
      });
      close();
    },
    [close, meta],
  );

  useEffect(() => {
    const label = getCurrentWebviewWindow().label;
    const id = label.startsWith("snip-") ? label.slice(5) : "";
    try {
      const raw = localStorage.getItem(`doccraft-snip-${id}`);
      if (!raw) throw new Error("missing snapshot");
      setMeta(JSON.parse(raw) as typeof meta);
    } catch {
      // Without a snapshot there is nothing to select over — bail out.
      cancel();
    }
  }, [cancel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);

  if (!meta) return null;

  const cssW = meta.width / meta.scaleFactor;
  const cssH = meta.height / meta.scaleFactor;

  return (
    <div
      className="fixed inset-0 cursor-crosshair overflow-hidden select-none"
      style={{ width: cssW, height: cssH }}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        dragStart.current = { x: e.clientX, y: e.clientY };
        setRect({ left: e.clientX, top: e.clientY, width: 0, height: 0 });
      }}
      onPointerMove={(e) => {
        const start = dragStart.current;
        if (!start) return;
        setRect({
          left: Math.min(start.x, e.clientX),
          top: Math.min(start.y, e.clientY),
          width: Math.abs(e.clientX - start.x),
          height: Math.abs(e.clientY - start.y),
        });
      }}
      onPointerUp={() => {
        const start = dragStart.current;
        dragStart.current = null;
        // Mirror the backend's minimum selection (4 physical px).
        const minCss = meta.scaleFactor > 0 ? 4 / meta.scaleFactor : 4;
        if (start && rect && rect.width >= minCss && rect.height >= minCss) {
          confirm(rect);
        } else {
          setRect(null);
        }
      }}
      onDoubleClick={() =>
        confirm({ left: 0, top: 0, width: cssW, height: cssH })
      }
      onContextMenu={(e) => {
        e.preventDefault();
        cancel();
      }}
    >
      <img
        src={meta.dataUrl}
        alt=""
        draggable={false}
        className="pointer-events-none absolute left-0 top-0"
        style={{ width: cssW, height: cssH }}
      />
      {rect ? (
        <div
          className="absolute border border-emerald-400 bg-transparent"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            // Dim everything outside the selection with a huge spread shadow.
            boxShadow: "0 0 0 100000px rgba(0, 0, 0, 0.35)",
            pointerEvents: "none",
          }}
        >
          <span className="absolute -top-6 right-0 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] leading-none text-white">
            {Math.round(rect.width * meta.scaleFactor)}×
            {Math.round(rect.height * meta.scaleFactor)}
          </span>
        </div>
      ) : null}
      <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/75 px-4 py-1.5 text-sm text-white">
        {t("snip.hint")}
      </div>
    </div>
  );
}

export default SnipOverlay;
