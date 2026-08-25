import { useCallback, useEffect, useRef, useState } from "react";
import { FileImage, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const SCALE_STEP = 1.25;

/**
 * Full-resolution image viewer for the Image → Markdown workspace: zoom via
 * buttons or Ctrl + mouse wheel and pan by scrolling (ScrollArea) once the
 * image overflows its container. Falls back to the low-res thumbnail when no
 * file-backed source is available (e.g. a screenshot whose save failed).
 */
export function ImagePreviewPane({
  src,
  fallbackSrc,
  name,
  className,
}: {
  /** Full-resolution source (asset-protocol URL). */
  src?: string;
  /** Low-res fallback (thumbnail data URL) when `src` is unavailable. */
  fallbackSrc?: string;
  name: string;
  className?: string;
}) {
  const { t } = useI18n();
  const [scale, setScale] = useState(1);
  const rootRef = useRef<HTMLDivElement>(null);
  /** Latest scale for stable event listeners. */
  const scaleRef = useRef(1);
  /**
   * Pending cursor-anchored scroll correction, applied after the new scale
   * has rendered: keep the content point under the pointer fixed while
   * zooming.
   */
  const pendingZoomRef = useRef<{
    cx: number;
    cy: number;
    mx: number;
    my: number;
    next: number;
  } | null>(null);

  const clamp = useCallback(
    (v: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v)),
    [],
  );

  const viewportOf = () =>
    rootRef.current?.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]",
    );

  /**
   * Zoom by `factor`, anchored at the pointer (`clientX`/`clientY`) or at
   * the viewport center when omitted (toolbar buttons).
   */
  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const viewport = viewportOf();
      const prev = scaleRef.current;
      const next = clamp(prev * factor);
      if (!viewport || next === prev) {
        setScale(next);
        return;
      }
      const rect = viewport.getBoundingClientRect();
      // Pointer offset within the visible area (center for buttons).
      const mx = clientX != null ? clientX - rect.left : rect.width / 2;
      const my = clientY != null ? clientY - rect.top : rect.height / 2;
      // Content-space coordinates of the point under the pointer, so the
      // same point stays under the pointer after the scale change.
      pendingZoomRef.current = {
        cx: (viewport.scrollLeft + mx) / prev,
        cy: (viewport.scrollTop + my) / prev,
        mx,
        my,
        next,
      };
      setScale(next);
    },
    [clamp],
  );

  useEffect(() => {
    scaleRef.current = scale;
    const p = pendingZoomRef.current;
    if (!p) return;
    pendingZoomRef.current = null;
    const viewport = viewportOf();
    if (!viewport) return;
    viewport.scrollLeft = p.cx * p.next - p.mx;
    viewport.scrollTop = p.cy * p.next - p.my;
  }, [scale]);

  // Ctrl + wheel zooms toward the pointer (non-passive so we can suppress
  // browser page zoom); plain wheel keeps scrolling the ScrollArea.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? SCALE_STEP : 1 / SCALE_STEP, e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const reset = useCallback(() => {
    setScale(1);
    viewportOf()?.scrollTo({ top: 0, left: 0 });
  }, []);

  const displaySrc = src ?? fallbackSrc;

  return (
    <div
      ref={rootRef}
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-xl glass-panel",
        className,
      )}
    >
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
          {name}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => zoomAt(1 / SCALE_STEP)}
                disabled={scale <= MIN_SCALE}
              >
                <ZoomOut />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("img2md.zoomOut")}</TooltipContent>
          </Tooltip>
          <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">
            {Math.round(scale * 100)}%
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => zoomAt(SCALE_STEP)}
                disabled={scale >= MAX_SCALE}
              >
                <ZoomIn />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("img2md.zoomIn")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={reset}>
                <RotateCcw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("img2md.zoomReset")}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Scrollable, zoomable canvas */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          {displaySrc ? (
            <img
              src={displaySrc}
              alt={name}
              draggable={false}
              className="mx-auto block max-w-none origin-top-left rounded-md border bg-[repeating-conic-gradient(var(--muted)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] shadow-sm"
              style={{ width: `${scale * 100}%` }}
            />
          ) : (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
              <FileImage className="size-8" />
              <p className="text-sm">{t("img2md.imageUnavailable")}</p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
