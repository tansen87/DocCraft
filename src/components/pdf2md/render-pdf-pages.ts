import { convertFileSrc } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { rectsForPage } from "@/lib/exclude-region";
import type {
  ActivityProgress,
  ConvertResult,
  ExcludeRegions,
  OcrPageImage,
} from "@/lib/types";
import {
  abortHybridSession,
  finishHybridSession,
  hybridPageOcr,
  startHybridSession,
} from "@/lib/ipc";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

/** Thrown when a conversion is cancelled via its `isCancelled` signal. */
export class CancelledError extends Error {
  constructor() {
    super("conversion cancelled");
    this.name = "CancelledError";
  }
}

/** Render DPI multiplier (~180 DPI). */
const OCR_RENDER_SCALE = 2.5;

/**
 * Paint the exclusion rects white on an already rendered page.
 *
 * The OCR pipeline never sees the excluded content, which is the image-side
 * counterpart of the backend's text-item filter. Rects are viewport-relative
 * PDF points (origin lower-left) while the canvas is top-left pixels.
 */
function maskExclusions(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  page: number,
  exclusions: ExcludeRegions | null | undefined,
): void {
  const rects = rectsForPage(exclusions, page);
  if (rects.length === 0) return;
  ctx.save();
  ctx.fillStyle = "#ffffff";
  for (const r of rects) {
    ctx.fillRect(
      r.x * OCR_RENDER_SCALE,
      canvas.height - (r.y + r.height) * OCR_RENDER_SCALE,
      r.width * OCR_RENDER_SCALE,
      r.height * OCR_RENDER_SCALE,
    );
  }
  ctx.restore();
}

/**
 * Yield OCR page images one at a time. The document is parsed once but each
 * page's bitmap + base64 payload exists only until the caller consumes it, so
 * peak memory stays at ~one page instead of the whole document.
 */
export async function* renderPdfPagesForOcr(
  path: string,
  pages: number[],
  exclusions?: ExcludeRegions | null,
): AsyncGenerator<OcrPageImage, void, void> {
  const task = pdfjs.getDocument({ url: convertFileSrc(path) });
  try {
    const doc = await task.promise;
    for (const pageNum of pages) {
      const page = await doc.getPage(pageNum);
      try {
        const viewport = page.getViewport({ scale: OCR_RENDER_SCALE });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, viewport }).promise;
        maskExclusions(ctx, canvas, pageNum, exclusions);
        const dataUrl = canvas.toDataURL("image/png");
        const comma = dataUrl.indexOf(",");
        yield {
          page: pageNum,
          imagePng: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
        };
        canvas.width = 0;
        canvas.height = 0;
      } finally {
        page.cleanup();
      }
    }
  } finally {
    task.destroy();
  }
}

/**
 * Hybrid conversion with per-page streaming: render → send one page at a time
 * so the backend never holds the whole document's images. Text pages are
 * extracted once by the backend session.
 *
 * When no usable OCR provider is configured, no pages are rendered or sent -
 * the backend skips them and records which pages were skipped in the result.
 */
export async function convertWithOcr(
  path: string,
  pages: number[],
  /** Optional per-page progress for the status bar activity indicator. */
  onProgress?: (p: ActivityProgress | null) => void,
  /** Pollled between stages; when it turns true the session is aborted. */
  isCancelled?: () => boolean,
  /** Optional page-range spec (`"1-5,8,12-14"`) passed to the backend so text
   * extraction is limited to those pages. `undefined` converts the whole document. */
  pageRange?: string,
  /** Regions whose content must not be recognized. */
  exclusions?: ExcludeRegions | null,
): Promise<ConvertResult> {
  if (isCancelled?.()) throw new CancelledError();
  const session = await startHybridSession(path, pages, pageRange, exclusions);
  try {
    if (session.ocrConfigured) {
      let done = 0;
      onProgress?.({ phase: "ocr", current: 0, total: pages.length });
      for await (const img of renderPdfPagesForOcr(path, pages, exclusions)) {
        if (isCancelled?.()) throw new CancelledError();
        await hybridPageOcr(session.sessionId, img.page, img.imagePng);
        done += 1;
        onProgress?.({ phase: "ocr", current: done, total: pages.length });
      }
    }
    if (isCancelled?.()) throw new CancelledError();
    return await finishHybridSession(session.sessionId);
  } catch (e) {
    await abortHybridSession(session.sessionId).catch(() => undefined);
    throw e;
  } finally {
    onProgress?.(null);
  }
}
