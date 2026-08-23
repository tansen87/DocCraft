import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useI18n } from "@/i18n";
import { ocrImageTable } from "@/lib/ipc";
import type { ImageTableResult } from "@/lib/types";

interface ImageTableOverlayProps {
  imagePath: string;
  onClose: () => void;
  onResult: (result: ImageTableResult) => void;
}

/**
 * Full-screen overlay that shows an image and lets the user draw vertical
 * lines on it to define table column boundaries.  On confirm the image +
 * line positions are sent to the backend for OCR + column cutting.
 */
export function ImageTableOverlay({
  imagePath,
  onClose,
  onResult,
}: ImageTableOverlayProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [lines, setLines] = useState<number[]>([]);
  const [dragging, setDragging] = useState<{
    index: number;
    startX: number;
    offsetX: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [imgSize, setImgSize] = useState<{
    naturalW: number;
    naturalH: number;
    displayW: number;
    displayH: number;
  } | null>(null);

  const onImageLoad = useCallback(() => {
    const img = imgRef.current;
    const container = containerRef.current;
    if (!img || !container) return;
    const containerRect = container.getBoundingClientRect();
    const maxW = containerRect.width - 32;
    const maxH = containerRect.height - 120;
    const scale = Math.min(
      maxW / img.naturalWidth,
      maxH / img.naturalHeight,
      1,
    );
    const displayW = img.naturalWidth * scale;
    const displayH = img.naturalHeight * scale;
    setImgSize({
      naturalW: img.naturalWidth,
      naturalH: img.naturalHeight,
      displayW,
      displayH,
    });
  }, []);

  const addLine = useCallback(
    (clientX: number) => {
      if (!imgSize) return;
      const imgEl = imgRef.current;
      if (!imgEl) return;
      const rect = imgEl.getBoundingClientRect();
      const pct = ((clientX - rect.left) / imgSize.displayW) * 100;
      const clamped = Math.max(0, Math.min(100, pct));
      setLines((prev) => {
        const next = [...prev, clamped];
        next.sort((a, b) => a - b);
        return next;
      });
    },
    [imgSize],
  );

  const removeLine = useCallback((index: number) => {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (loading) return;
      // Check if the click is on a line drag handle (handled by the line's
      // own pointer events).  Otherwise add a new line.
      const target = e.target as HTMLElement;
      if (target.closest("[data-line-handle]")) return;
      addLine(e.clientX);
    },
    [addLine, loading],
  );

  const handleLinePointerDown = useCallback(
    (index: number, e: React.PointerEvent) => {
      if (loading) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setDragging({
        index,
        startX: e.clientX,
        offsetX: 0,
      });
    },
    [loading],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging || !imgSize) return;
      const imgEl = imgRef.current;
      if (!imgEl) return;
      const rect = imgEl.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / imgSize.displayW) * 100;
      const clamped = Math.max(0, Math.min(100, pct));
      setLines((prev) => {
        const next = [...prev];
        next[dragging.index] = clamped;
        return next;
      });
    },
    [dragging, imgSize],
  );

  const handlePointerUp = useCallback(() => {
    setDragging(null);
  }, []);

  const handleDblClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const lineIdx = target
        .closest("[data-line-idx]")
        ?.getAttribute("data-line-idx");
      if (lineIdx !== null && lineIdx !== undefined) {
        removeLine(Number(lineIdx));
      }
    },
    [removeLine],
  );

  const handleConfirm = useCallback(async () => {
    if (lines.length === 0) {
      toast.error(t("imgTable.needLine"));
      return;
    }
    setLoading(true);
    try {
      const result = await ocrImageTable({
        imagePath,
        verticalLines: lines,
      });
      onResult(result);
      onClose();
    } catch (e) {
      toast.error(t("imgTable.extractFailed"), { description: String(e) });
    } finally {
      setLoading(false);
    }
  }, [lines, imagePath, onResult, onClose]);

  // Keyboard shortcut: Enter to confirm, Esc to cancel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter" && !loading) {
        void handleConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, handleConfirm, loading]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90"
      ref={containerRef}
    >
      {/* Header bar */}
      <div className="flex shrink-0 items-center justify-between px-4 py-2">
        <span className="text-sm text-white/60">
          {t("drawtable.instruction")}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleConfirm}
            disabled={loading || lines.length === 0}
          >
            {loading ? <Loader2 className="animate-spin" /> : null}
            {loading ? t("drawtable.extracting") : t("drawtable.extract")}
          </Button>
          <Button
            variant="secondary"
            size="icon-sm"
            onClick={onClose}
            disabled={loading}
          >
            <X />
          </Button>
        </div>
      </div>

      {/* Image area */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {!imgSize && (
          <img
            ref={imgRef}
            src={convertFileSrc(imagePath)}
            alt=""
            className="hidden"
            onLoad={onImageLoad}
          />
        )}
        {imgSize && (
          <div
            className="relative cursor-crosshair"
            style={{ width: imgSize.displayW, height: imgSize.displayH }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onDoubleClick={handleDblClick}
          >
            <img
              ref={imgRef}
              src={convertFileSrc(imagePath)}
              alt=""
              className="pointer-events-none block"
              style={{ width: imgSize.displayW, height: imgSize.displayH }}
              onLoad={onImageLoad}
            />
            <svg
              ref={svgRef}
              className="pointer-events-none absolute left-0 top-0"
              width={imgSize.displayW}
              height={imgSize.displayH}
            >
              {lines.map((pct, i) => {
                const x = (pct / 100) * imgSize.displayW;
                return (
                  <g
                    key={i}
                    data-line-idx={i}
                    data-line-handle=""
                    className="pointer-events-auto"
                    onPointerDown={(e) => handleLinePointerDown(i, e)}
                  >
                    <line
                      x1={x}
                      y1={0}
                      x2={x}
                      y2={imgSize.displayH}
                      stroke="rgba(239, 68, 68, 0.85)"
                      strokeWidth={2}
                      strokeDasharray="6 3"
                    />
                    {/* Invisible wider hit area for dragging */}
                    <line
                      x1={x}
                      y1={0}
                      x2={x}
                      y2={imgSize.displayH}
                      stroke="transparent"
                      strokeWidth={14}
                      style={{ cursor: "ew-resize" }}
                    />
                    {/* Drag handle dot */}
                    <circle
                      cx={x}
                      cy={imgSize.displayH / 2}
                      r={5}
                      fill="rgba(239, 68, 68, 0.85)"
                      style={{ cursor: "ew-resize" }}
                    />
                  </g>
                );
              })}
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}

export default ImageTableOverlay;
