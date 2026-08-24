import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { useI18n } from "@/i18n";

const MAGNIFIER_SIZE = 160;
const MAGNIFIER_ZOOM = 2;
const TOOL_PANEL_W = 176;
const TOOL_PANEL_H = 200;

/**
 * Fullscreen region-selection overlay shown inside a per-monitor snip window
 * (label `snip-<monitorId>`). The frozen monitor snapshot is displayed as the
 * background; the user drags a rectangle and the selection is reported to the
 * main window in physical pixels via the `snip:selected` event.
 *
 * A small tool palette follows the cursor and shows a magnifier, the physical
 * screen coordinates, the color under the cursor, and the window element
 * below the cursor so users clearly feel they are in screenshot mode.
 */
export function SnipOverlay() {
  const { t } = useI18n();
  const [meta, setMeta] = useState<{
    dataUrl: string;
    width: number;
    height: number;
    scaleFactor: number;
    x: number;
    y: number;
  } | null>(null);
  /** Drag state in CSS pixels: selection start + current point. */
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<null | {
    left: number;
    top: number;
    width: number;
    height: number;
  }>(null);

  /** Cursor position in CSS pixels relative to this monitor. */
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [color, setColor] = useState<{
    r: number;
    g: number;
    b: number;
    a: number;
  } | null>(null);

  const imgRef = useRef<HTMLImageElement>(null);
  const fullCanvasRef = useRef<HTMLCanvasElement>(null);
  const magCanvasRef = useRef<HTMLCanvasElement>(null);

  /**
   * Overlay windows are reused across snips (hidden, not closed). The main
   * window pushes a fresh snapshot via `snip:meta` before revealing us.
   */
  useEffect(() => {
    const unlisten = listen<{
      dataUrl: string;
      width: number;
      height: number;
      scaleFactor: number;
      x: number;
      y: number;
    }>("snip:meta", (e) => {
      dragStart.current = null;
      setRect(null);
      setCursor(null);
      setColor(null);
      setMeta(e.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  /** Reveal the window once the snapshot is actually painted. */
  const reveal = useCallback(() => {
    const win = getCurrentWebviewWindow();
    void win.show();
    void win.setFocus();
    void win.setAlwaysOnTop(true);
  }, []);

  const close = useCallback(() => {
    void getCurrentWebviewWindow().hide();
  }, []);

  const cancel = useCallback(() => {
    void emit("snip:cancelled");
    close();
  }, [close]);

  const confirm = useCallback(
    (r: { left: number; top: number; width: number; height: number }) => {
      const metaNow = meta;
      if (!metaNow) return;
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

  const onImageLoad = useCallback(() => {
    const img = imgRef.current;
    const canvas = fullCanvasRef.current;
    const metaNow = meta;
    if (!img || !canvas || !metaNow) return;
    canvas.width = metaNow.width;
    canvas.height = metaNow.height;
    const ctx = canvas.getContext("2d");
    ctx?.drawImage(img, 0, 0);
    // Snapshot is painted - reveal the (hidden or brand-new) overlay window.
    reveal();
  }, [meta, reveal]);

  const updateMagnifierAndColor = useCallback(
    (cssX: number, cssY: number) => {
      const img = imgRef.current;
      const fullCanvas = fullCanvasRef.current;
      const magCanvas = magCanvasRef.current;
      const metaNow = meta;
      if (!img || !fullCanvas || !magCanvas || !metaNow) return;

      // Sample from the full-resolution canvas (physical pixels).
      const fx = Math.min(
        Math.max(Math.round(cssX * metaNow.scaleFactor), 0),
        metaNow.width - 1,
      );
      const fy = Math.min(
        Math.max(Math.round(cssY * metaNow.scaleFactor), 0),
        metaNow.height - 1,
      );
      const fctx = fullCanvas.getContext("2d");
      if (fctx) {
        const pixel = fctx.getImageData(fx, fy, 1, 1).data;
        setColor({ r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3] });
      }

      // Draw the zoomed area into the magnifier canvas.
      const size = MAGNIFIER_SIZE;
      const zoom = MAGNIFIER_ZOOM;
      const srcSize = size / zoom;
      const mctx = magCanvas.getContext("2d");
      if (!mctx) return;
      magCanvas.width = size;
      magCanvas.height = size;
      mctx.imageSmoothingEnabled = false;
      mctx.clearRect(0, 0, size, size);
      mctx.drawImage(
        img,
        cssX - srcSize / 2,
        cssY - srcSize / 2,
        srcSize,
        srcSize,
        0,
        0,
        size,
        size,
      );
      // Crosshair centered on the exact pixel being sampled.
      mctx.strokeStyle = "rgba(239, 68, 68, 0.9)";
      mctx.lineWidth = 1;
      mctx.beginPath();
      mctx.moveTo(size / 2, 0);
      mctx.lineTo(size / 2, size);
      mctx.moveTo(0, size / 2);
      mctx.lineTo(size, size / 2);
      mctx.stroke();
    },
    [meta],
  );

  useEffect(() => {
    const label = getCurrentWebviewWindow().label;
    const id = label.startsWith("snip-") ? label.slice(5) : "";
    try {
      const raw = localStorage.getItem(`doccraft-snip-${id}`);
      if (!raw) throw new Error("missing snapshot");
      setMeta(JSON.parse(raw) as typeof meta);
    } catch {
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

  const handlePointerMove = (e: React.PointerEvent) => {
    setCursor({ x: e.clientX, y: e.clientY });
    updateMagnifierAndColor(e.clientX, e.clientY);

    const start = dragStart.current;
    if (!start) return;
    setRect({
      left: Math.min(start.x, e.clientX),
      top: Math.min(start.y, e.clientY),
      width: Math.abs(e.clientX - start.x),
      height: Math.abs(e.clientY - start.y),
    });
  };

  // Position the tool panel to the bottom-right of the cursor, flipping when
  // it would overflow the monitor edge.
  const panelPos = (() => {
    if (!cursor) return { left: -9999, top: -9999 };
    let left = cursor.x + 16;
    let top = cursor.y + 16;
    if (left + TOOL_PANEL_W > cssW) left = cursor.x - TOOL_PANEL_W - 16;
    if (top + TOOL_PANEL_H > cssH) top = cursor.y - TOOL_PANEL_H - 16;
    return { left, top };
  })();

  const physicalCursor = cursor && {
    x: Math.round(meta.x + cursor.x * meta.scaleFactor),
    y: Math.round(meta.y + cursor.y * meta.scaleFactor),
  };

  const colorHex =
    color &&
    `#${[color.r, color.g, color.b]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")}`;

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
      onPointerMove={handlePointerMove}
      onPointerUp={() => {
        const start = dragStart.current;
        dragStart.current = null;
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
        ref={imgRef}
        src={meta.dataUrl}
        alt=""
        draggable={false}
        className="pointer-events-none absolute left-0 top-0"
        style={{ width: cssW, height: cssH }}
        onLoad={onImageLoad}
      />
      {/* Hidden canvas holding the full-resolution image for pixel sampling. */}
      <canvas
        ref={fullCanvasRef}
        className="pointer-events-none absolute left-0 top-0 opacity-0"
      />
      {/* Dim the frozen screen while no region is picked yet, so users can
          clearly tell capture mode is active (the selection's own spread
          shadow takes over once dragging starts). */}
      {!rect ? (
        <div className="pointer-events-none absolute inset-0 bg-black/30" />
      ) : null}
      {/* Bright frame around the whole monitor marking the capture bounds. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ boxShadow: "inset 0 0 0 2px rgba(52, 211, 153, 0.9)" }}
      />
      {rect ? (
        <div
          className="absolute border border-emerald-400 bg-transparent"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
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

      {/* Cursor-following tool palette. */}
      <div
        className="pointer-events-none absolute z-50 rounded-lg border border-white/10 bg-black/80 p-2 text-xs text-white shadow-lg backdrop-blur-sm"
        style={{ left: panelPos.left, top: panelPos.top, width: TOOL_PANEL_W }}
      >
        <canvas
          ref={magCanvasRef}
          width={MAGNIFIER_SIZE}
          height={MAGNIFIER_SIZE}
          className="mb-2 block rounded border border-white/20"
          style={{ width: MAGNIFIER_SIZE, height: MAGNIFIER_SIZE }}
        />
        <div className="space-y-1 font-mono">
          <div className="flex justify-between">
            <span className="text-white/60">{t("snip.coordinates")}</span>
            <span>
              {physicalCursor
                ? `${physicalCursor.x}, ${physicalCursor.y}`
                : "-"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-white/60">{t("snip.color")}</span>
            <div className="flex items-center gap-1.5">
              {color && (
                <span
                  className="inline-block h-3 w-3 rounded-sm border border-white/30"
                  style={{
                    backgroundColor: `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a / 255})`,
                  }}
                />
              )}
              <span>{colorHex ? colorHex.toUpperCase() : "-"}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/75 px-4 py-1.5 text-sm text-white">
        {t("snip.hint")}
      </div>
    </div>
  );
}

export default SnipOverlay;
