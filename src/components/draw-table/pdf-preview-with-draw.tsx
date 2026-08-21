import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";

import { DrawTablePanel } from "@/components/draw-table/draw-table-panel";
import { PdfPreview } from "@/components/pdf2md/pdf-preview";
import type { DrawTableResult } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PdfPreviewWithDrawProps {
  path: string;
  pdfPath: string;
  className?: string;
  onResultExtracted: (result: DrawTableResult) => void;
  onMarkdownMerged: (markdown: string, processingTimeMs?: number) => void;
  enabled: boolean;
}

/**
 * PDF preview with overlay canvas for user-drawn table definition.
 * When draw mode is enabled, renders the PDF preview and overlay.
 */
export function PdfPreviewWithDraw({
  path,
  pdfPath,
  className,
  enabled,
  onMarkdownMerged,
}: PdfPreviewWithDrawProps) {
  const [currentPage] = useState(1);
  const [pageSize, setPageSize] = useState<{
    pageWidth: number; // PDF points
    pageHeight: number; // PDF points
    canvasWidth: number; // CSS pixels
    canvasHeight: number; // CSS pixels
    scale: number; // CSS pixels per PDF point
    pageX: number; // PDF points, viewBox lower-left x
    pageY: number; // PDF points, viewBox lower-left y
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  // When the container size changes, update canvas dimensions
  useEffect(() => {
    if (!enabled || !containerRef.current) return;

    const container = containerRef.current;
    const rect = container.getBoundingClientRect();

    // Try to get the current page size from pdfjs
    const task = pdfjs.getDocument({ url: path });
    task.promise.then((doc) => {
      doc.getPage(currentPage).then((page) => {
        const viewport = page.getViewport({ scale: 1 });
        const rawDims = viewport.rawDims as {
          pageWidth: number;
          pageHeight: number;
          pageX: number;
          pageY: number;
        };
        // PDF viewport already gives width and height in PDF points
        const pdfWidth = rawDims.pageWidth;
        const pdfHeight = rawDims.pageHeight;
        const pageX = rawDims.pageX;
        const pageY = rawDims.pageY;

        // Calculate scale to fit container width
        const availableWidth = rect.width;
        const scale = availableWidth / pdfWidth;
        const canvasWidth = pdfWidth * scale;
        const canvasHeight = pdfHeight * scale;

        setPageSize({
          pageWidth: pdfWidth,
          pageHeight: pdfHeight,
          canvasWidth,
          canvasHeight,
          scale,
          pageX,
          pageY,
        });

        page.cleanup();
      });
    });
    task.destroy();

    // Also add resize observer to handle container size changes
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        if (!containerRef.current) return;
        const newRect = containerRef.current.getBoundingClientRect();
        if (!pageSize) return;
        const newScale = newRect.width / pageSize.pageWidth;
        setPageSize((prev) =>
          prev
            ? {
                ...prev,
                canvasWidth: prev.pageWidth * newScale,
                canvasHeight: prev.pageHeight * newScale,
                scale: newScale,
              }
            : null,
        );
      });
      resizeObserver.observe(container);
    }

    return () => {
      resizeObserver?.disconnect();
    };
  }, [path, enabled, currentPage, pageSize]);

  if (!enabled) {
    return (
      <div ref={containerRef} className={cn("relative h-full", className)}>
        <PdfPreview path={path} className="h-full" />
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col h-full gap-2", className)}>
      <div ref={containerRef} className="relative flex-1 overflow-hidden">
        {/* Base PDF preview */}
        <div className="absolute inset-0">
          <PdfPreview path={path} className="h-full" />
        </div>
        {/* Overlay drawing canvas */}
        {pageSize && (
          <div className="absolute inset-0">
            <DrawTablePanel
              pdfPath={pdfPath}
              path={path}
              currentPage={currentPage}
              pageCount={1}
              onPrevPage={() => {}}
              onNextPage={() => {}}
              scale={pageSize.scale}
              canvasWidth={pageSize.canvasWidth}
              canvasHeight={pageSize.canvasHeight}
              pageX={pageSize.pageX}
              pageY={pageSize.pageY}
              pageWidth={pageSize.pageWidth}
              pageHeight={pageSize.pageHeight}
              onMergeToMarkdown={onMarkdownMerged}
            />
          </div>
        )}
      </div>
    </div>
  );
}
