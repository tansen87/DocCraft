import { useCallback, useRef, useState } from "react";

import type { DrawLine, DrawMode } from "@/lib/types";

interface CanvasOverlayProps {
  /** Current rendering scale (CSS pixels per PDF point) */
  scale: number;
  /** What a click creates / which direction the coordinates refer to. */
  mode: Extract<DrawMode, "horizontal" | "vertical">;
  /** Vertical (column separator) lines on this page */
  verticalLines: DrawLine[];
  /** Horizontal (row boundary) lines on this page */
  horizontalLines: DrawLine[];
  /** Called when a new line is added */
  onLineAdd: (line: DrawLine) => void;
  /** Called when a line is removed */
  onLineRemove: (id: string) => void;
  /** Called when a line position changes (drag) */
  onLineUpdate: (id: string, canvasValue: number, pdfValue: number) => void;
  /** Canvas width in CSS pixels */
  width: number;
  /** Canvas height in CSS pixels */
  height: number;
}

const VERTICAL_COLOR = "#ef4444"; // red - column separators
const HORIZONTAL_COLOR = "#3b82f6"; // blue - row boundaries

export function CanvasOverlay({
  scale,
  mode,
  verticalLines,
  horizontalLines,
  onLineAdd,
  onLineRemove,
  onLineUpdate,
  width,
  height,
}: CanvasOverlayProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(
    null,
  );

  /** Convert canvas coordinates to PDF user-space coordinates. */
  const canvasToPdf = useCallback(
    (canvasX: number, canvasY: number) => ({
      pdfX: canvasX / scale,
      pdfY: (height - canvasY) / scale, // PDF origin is bottom-left
    }),
    [scale, height],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      if (mode === "vertical") {
        const { pdfX } = canvasToPdf(canvasX, canvasY);
        onLineAdd({
          id: crypto.randomUUID(),
          type: "vertical",
          pdfValue: pdfX,
          canvasValue: canvasX,
          color: VERTICAL_COLOR,
        });
      } else {
        const { pdfY } = canvasToPdf(canvasX, canvasY);
        onLineAdd({
          id: crypto.randomUUID(),
          type: "horizontal",
          pdfValue: pdfY,
          canvasValue: canvasY,
          color: HORIZONTAL_COLOR,
        });
      }
    },
    [mode, canvasToPdf, onLineAdd],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;
      setMousePos({ x: canvasX, y: canvasY });

      if (dragging) {
        const vLine = verticalLines.find((l) => l.id === dragging);
        if (vLine) {
          const { pdfX } = canvasToPdf(canvasX, canvasY);
          onLineUpdate(dragging, canvasX, pdfX);
          return;
        }
        const hLine = horizontalLines.find((l) => l.id === dragging);
        if (hLine) {
          const { pdfY } = canvasToPdf(canvasX, canvasY);
          onLineUpdate(dragging, canvasY, pdfY);
        }
      }
    },
    [dragging, verticalLines, horizontalLines, canvasToPdf, onLineUpdate],
  );

  const handleMouseUp = useCallback(() => {
    setDragging(null);
  }, []);

  const handleLineMouseDown = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDragging(id);
  }, []);

  const handleLineDoubleClick = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      onLineRemove(id);
    },
    [onLineRemove],
  );

  const { pdfX: mousePdfX, pdfY: mousePdfY } = mousePos
    ? canvasToPdf(mousePos.x, mousePos.y)
    : { pdfX: 0, pdfY: 0 };

  return (
    <svg
      ref={svgRef}
      className="absolute left-0 top-0 block"
      style={{ width, height, cursor: "crosshair" }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => {
        setDragging(null);
        setMousePos(null);
      }}
    >
      {/* Semi-transparent overlay to capture mouse events */}
      <rect
        x={0}
        y={0}
        width={width}
        height={height}
        className="fill-foreground/[0.02]"
      />

      {/* Vertical lines (column separators) */}
      {verticalLines.map((line) => {
        const x = line.canvasValue;
        return (
          <g
            key={line.id}
            onMouseDown={(e) => handleLineMouseDown(e, line.id)}
            onDoubleClick={(e) => handleLineDoubleClick(e, line.id)}
            style={{ cursor: "grab" }}
          >
            <line
              x1={x}
              y1={0}
              x2={x}
              y2={height}
              stroke={line.color}
              strokeWidth={2}
              strokeDasharray="6,3"
            />
            {/* Wider invisible hit area for easier clicking */}
            <line
              x1={x - 5}
              y1={0}
              x2={x - 5}
              y2={height}
              stroke="transparent"
              strokeWidth={10}
            />
            <circle cx={x} cy={8} r={4} fill={line.color} />
          </g>
        );
      })}

      {/* Horizontal lines (row boundaries) */}
      {horizontalLines.map((line) => {
        const y = line.canvasValue;
        return (
          <g
            key={line.id}
            onMouseDown={(e) => handleLineMouseDown(e, line.id)}
            onDoubleClick={(e) => handleLineDoubleClick(e, line.id)}
            style={{ cursor: "grab" }}
          >
            <line
              x1={0}
              y1={y}
              x2={width}
              y2={y}
              stroke={line.color}
              strokeWidth={2}
              strokeDasharray="6,3"
            />
            {/* Wider invisible hit area for easier clicking */}
            <line
              x1={0}
              y1={y - 5}
              x2={width}
              y2={y - 5}
              stroke="transparent"
              strokeWidth={10}
            />
            <circle cx={width - 8} cy={y} r={4} fill={line.color} />
          </g>
        );
      })}

      {/* Coordinate indicator */}
      {mousePos && (
        <text
          x={8}
          y={height - 8}
          className="pointer-events-none select-none fill-muted-foreground"
          fontSize={11}
        >
          PDF: ({mousePdfX.toFixed(1)}, {mousePdfY.toFixed(1)}) | CSS: (
          {mousePos.x.toFixed(0)}, {mousePos.y.toFixed(0)})
        </text>
      )}
    </svg>
  );
}
