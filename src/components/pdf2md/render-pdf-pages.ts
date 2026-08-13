import { convertFileSrc } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import type { ConvertResult, OcrPageImage } from "@/lib/types";
import {
  abortHybridSession,
  finishHybridSession,
  hybridPageOcr,
  startHybridSession,
} from "@/lib/ipc";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

/** Render DPI multiplier (~180 DPI). */
const OCR_RENDER_SCALE = 2.5;

/**
 * Yield OCR page images one at a time. The document is parsed once but each
 * page's bitmap + base64 payload exists only until the caller consumes it, so
 * peak memory stays at ~one page instead of the whole document.
 */
export async function* renderPdfPagesForOcr(
  path: string,
  pages: number[],
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
 */
export async function convertWithOcr(
  path: string,
  pages: number[],
): Promise<ConvertResult> {
  const session = await startHybridSession(path, pages);
  try {
    for await (const img of renderPdfPagesForOcr(path, pages)) {
      await hybridPageOcr(session.sessionId, img.page, img.imagePng);
    }
    return await finishHybridSession(session.sessionId);
  } catch (e) {
    await abortHybridSession(session.sessionId).catch(() => undefined);
    throw e;
  }
}
