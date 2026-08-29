import { useCallback, useEffect, useRef, useState } from "react";

import { useI18n } from "@/i18n";
import type { ExcludeRect } from "@/lib/types";
import { MIN_EXCLUDE_SIZE } from "@/lib/exclude-region";
import { cn } from "@/lib/utils";

/** A rect being dragged, tracked in CSS pixels until it is committed. */
interface Draft {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Corner = "nw" | "ne" | "sw" | "se";

interface DragState {
  mode: "create" | "move" | "resize";
  startX: number;
  startY: number;
  index: number;
  corner: Corner;
  origin: ExcludeRect;
}

interface ExcludeOverlayProps {
  /** 1-indexed page number (used to keep SVG pattern ids unique). */
  page: number;
  /** Page size in PDF points. */
  pageWidth: number;
  pageHeight: number;
  /** Rotated pages cannot carry rects yet - the overlay is inert. */
  disabled?: boolean;
  rects: ExcludeRect[];
  onChange: (rects: ExcludeRect[]) => void;
  className?: string;
}

const HANDLE = 5;
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

/**
 * Drawing surface for PDF exclusion regions.
 *
 * Rects are handed to the caller in PDF points with the origin at the
 * lower-left corner; the overlay converts from its own CSS pixel space
 * (origin top-left) in both directions.
 */
export function ExcludeOverlay({
  page,
  pageWidth,
  pageHeight,
  disabled,
  rects,
  onChange,
  className,
}: ExcludeOverlayProps) {
  const { t } = useI18n();
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragState | null>(null);
  /**
   * Last pointerdown on a rect, used to detect double-clicks. Native
   * `dblclick` on the `<g>` is unreliable here: `setPointerCapture` redirects
   * compatibility mouse events to the SVG root, so we detect the double-click
   * from the second `pointerdown` itself.
   */
  const lastRectDownRef = useRef<{ index: number; time: number }>({
    index: -1,
    time: 0,
  });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  // The overlay fills the page wrapper, whose box already matches the rendered
  // page, so its own size gives the CSS-pixels-per-PDF-point scale.
  useEffect(() => {
    const el = svgRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = pageWidth > 0 ? size.width / pageWidth : 0;

  const toPdf = useCallback(
    (x: number, y: number) => ({
      x: x / scale,
      y: (size.height - y) / scale,
    }),
    [scale, size.height],
  );

  const localPoint = (e: React.PointerEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    return {
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0),
    };
  };

  const commit = useCallback(
    (next: ExcludeRect[]) => {
      onChange(
        next
          .filter((r) => r.width > 0.5 && r.height > 0.5)
          .map((r) => ({
            x: Math.round(r.x * 100) / 100,
            y: Math.round(r.y * 100) / 100,
            width: Math.round(r.width * 100) / 100,
            height: Math.round(r.height * 100) / 100,
          })),
      );
    },
    [onChange],
  );

  const beginDrag = (e: React.PointerEvent, state: DragState) => {
    e.stopPropagation();
    e.preventDefault();
    svgRef.current?.setPointerCapture(e.pointerId);
    dragRef.current = state;
  };

  const handleBackgroundDown = (e: React.PointerEvent) => {
    if (disabled) return;
    const { x, y } = localPoint(e);
    setSelected(null);
    beginDrag(e, {
      mode: "create",
      startX: x,
      startY: y,
      index: -1,
      corner: "se",
      origin: { x: 0, y: 0, width: 0, height: 0 },
    });
    setDraft({ x, y, width: 0, height: 0 });
  };

  const handleRectDown = (e: React.PointerEvent, index: number) => {
    if (disabled) return;
    const now = Date.now();
    const last = lastRectDownRef.current;
    // Second press on the same rect within the double-click window deletes it.
    if (last.index === index && now - last.time < 300) {
      e.stopPropagation();
      e.preventDefault();
      lastRectDownRef.current = { index: -1, time: 0 };
      commit(rects.filter((_, i) => i !== index));
      setSelected(null);
      return;
    }
    lastRectDownRef.current = { index, time: now };
    const { x, y } = localPoint(e);
    setSelected(index);
    beginDrag(e, {
      mode: "move",
      startX: x,
      startY: y,
      index,
      corner: "se",
      origin: { ...rects[index] },
    });
  };

  const handleHandleDown = (
    e: React.PointerEvent,
    index: number,
    corner: Corner,
  ) => {
    if (disabled) return;
    const { x, y } = localPoint(e);
    setSelected(index);
    beginDrag(e, {
      mode: "resize",
      startX: x,
      startY: y,
      index,
      corner,
      origin: { ...rects[index] },
    });
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || scale <= 0) return;
    const { x, y } = localPoint(e);

    if (drag.mode === "create") {
      setDraft({
        x: Math.min(drag.startX, x),
        y: Math.min(drag.startY, y),
        width: Math.abs(x - drag.startX),
        height: Math.abs(y - drag.startY),
      });
      return;
    }

    const dxPt = (x - drag.startX) / scale;
    const dyPt = (drag.startY - y) / scale;
    const o = drag.origin;

    if (drag.mode === "move") {
      const next = rects.slice();
      next[drag.index] = {
        ...o,
        x: clamp(o.x + dxPt, 0, pageWidth - o.width),
        y: clamp(o.y + dyPt, 0, pageHeight - o.height),
      };
      commit(next);
      return;
    }

    // Resize: only the two edges adjacent to the dragged corner move.
    let { x: nx, y: ny, width: nw, height: nh } = o;
    if (drag.corner === "nw" || drag.corner === "sw") {
      const right = o.x + o.width;
      nx = clamp(o.x + dxPt, 0, right - 1);
      nw = right - nx;
    } else {
      nw = clamp(o.width + dxPt, 1, pageWidth - o.x);
    }
    if (drag.corner === "sw" || drag.corner === "se") {
      ny = clamp(o.y + dyPt, 0, o.y + o.height - 1);
      nh = o.y + o.height - ny;
    } else {
      nh = clamp(o.height + dyPt, 1, pageHeight - o.y);
    }
    const next = rects.slice();
    next[drag.index] = { x: nx, y: ny, width: nw, height: nh };
    commit(next);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    svgRef.current?.releasePointerCapture?.(e.pointerId);
    if (!drag || drag.mode !== "create" || !draft) {
      setDraft(null);
      return;
    }
    setDraft(null);
    // Ignore stray clicks: a rect has to be dragged out to a usable size.
    if (
      draft.width / scale < MIN_EXCLUDE_SIZE ||
      draft.height / scale < MIN_EXCLUDE_SIZE
    ) {
      return;
    }
    const topLeft = toPdf(draft.x, draft.y + draft.height);
    const next: ExcludeRect = {
      x: clamp(topLeft.x, 0, pageWidth),
      y: clamp(topLeft.y, 0, pageHeight),
      width: Math.min(draft.width / scale, pageWidth - topLeft.x),
      height: Math.min(draft.height / scale, pageHeight - topLeft.y),
    };
    commit([...rects, next]);
    setSelected(rects.length);
  };

  // Delete the selected rect with the keyboard.
  useEffect(() => {
    if (selected === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      // Never steal the key from a text field (page range, search, ...).
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      commit(rects.filter((_, i) => i !== selected));
      setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, rects, commit]);

  const cssRect = (r: ExcludeRect) => ({
    x: r.x * scale,
    y: size.height - (r.y + r.height) * scale,
    width: r.width * scale,
    height: r.height * scale,
  });

  const handlesOf = (r: ExcludeRect) => {
    const box = cssRect(r);
    return CORNERS.map((corner) => ({
      corner,
      cx: corner === "nw" || corner === "sw" ? box.x : box.x + box.width,
      cy: corner === "nw" || corner === "ne" ? box.y : box.y + box.height,
    }));
  };

  const patternId = `exclude-hatch-${page}`;

  return (
    <svg
      ref={svgRef}
      className={cn(
        "absolute inset-0 block h-full w-full",
        disabled ? "pointer-events-none" : "cursor-crosshair",
        className,
      )}
      onPointerDown={handleBackgroundDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <defs>
        <pattern
          id={patternId}
          width={8}
          height={8}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line
            x1={0}
            y1={0}
            x2={0}
            y2={8}
            className="stroke-amber-500/60"
            strokeWidth={2}
          />
        </pattern>
      </defs>

      {/* Transparent hit area that captures drags on empty space. */}
      <rect
        x={0}
        y={0}
        width="100%"
        height="100%"
        className="fill-transparent"
      />

      {rects.map((r, index) => {
        const box = cssRect(r);
        const active = selected === index;
        return (
          <g
            key={index}
            style={{ cursor: disabled ? "default" : "move" }}
            onPointerDown={(e) => handleRectDown(e, index)}
          >
            <rect
              x={box.x}
              y={box.y}
              width={box.width}
              height={box.height}
              className="fill-amber-500/10"
            />
            <rect
              x={box.x}
              y={box.y}
              width={box.width}
              height={box.height}
              fill={`url(#${patternId})`}
              className={active ? "stroke-amber-500" : "stroke-amber-500/70"}
              strokeWidth={active ? 2 : 1.5}
              strokeDasharray="5,3"
            />
            {active
              ? handlesOf(r).map(({ corner, cx, cy }) => (
                  <rect
                    key={corner}
                    x={cx - HANDLE}
                    y={cy - HANDLE}
                    width={HANDLE * 2}
                    height={HANDLE * 2}
                    className="fill-background stroke-amber-500"
                    strokeWidth={1.5}
                    style={{ cursor: `${corner}-resize` }}
                    onPointerDown={(e) => handleHandleDown(e, index, corner)}
                  />
                ))
              : null}
            {active ? (
              <text
                x={box.x + 4}
                y={box.y + 14}
                className="pointer-events-none select-none fill-amber-600 dark:fill-amber-400"
                fontSize={11}
              >
                {Math.round(r.width)} × {Math.round(r.height)}
              </text>
            ) : null}
          </g>
        );
      })}

      {draft ? (
        <rect
          x={draft.x}
          y={draft.y}
          width={draft.width}
          height={draft.height}
          className="fill-amber-500/10 stroke-amber-500"
          strokeWidth={1.5}
          strokeDasharray="5,3"
        />
      ) : null}

      {disabled ? (
        <text x={8} y={18} className="fill-muted-foreground" fontSize={11}>
          {t("exclude.rotationSkipped")}
        </text>
      ) : null}
    </svg>
  );
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}
