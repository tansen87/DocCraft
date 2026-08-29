import type { ExcludeRect, ExcludeRegions, PageExclude } from "./types";

/**
 * Helpers for the PDF exclusion regions feature
 * (`docs/design/00010_pdf-exclude-region.md`).
 *
 * Rects are stored in **viewport-relative PDF points with the origin at the
 * lower-left corner**, the same space `PageDrawTable` uses, so the backend can
 * shift them by `pageX/pageY` before comparing them with pdf-inspector's
 * absolute user-space coordinates.
 */

/** Smallest rect (in PDF points) accepted from a drag; below this it is a click. */
export const MIN_EXCLUDE_SIZE = 8;

/** Clamp a rect to the page box, returning `null` when nothing is left. */
export function clampRect(
  rect: ExcludeRect,
  pageWidth: number,
  pageHeight: number,
): ExcludeRect | null {
  if (pageWidth <= 0 || pageHeight <= 0) return { ...rect };
  const x = Math.min(Math.max(rect.x, 0), pageWidth);
  const y = Math.min(Math.max(rect.y, 0), pageHeight);
  const width = Math.min(rect.x + rect.width, pageWidth) - x;
  const height = Math.min(rect.y + rect.height, pageHeight) - y;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * Rects that apply to `page`. A page with its own entry always wins (an empty
 * `rects` list opts the page out), otherwise the first page carrying rects is
 * the template for every page when `useForAllPages` is set.
 *
 * Mirrors `core::region_exclude::rects_for_page` on the backend.
 */
export function rectsForPage(
  spec: ExcludeRegions | null | undefined,
  page: number,
): ExcludeRect[] {
  if (!spec || spec.pages.length === 0) return [];
  const entry = spec.pages.find((p) => p.page === page);
  if (entry) {
    return entry.rects
      .map((r) => clampRect(r, entry.pageWidth, entry.pageHeight))
      .filter((r): r is ExcludeRect => r !== null);
  }
  if (!spec.useForAllPages) return [];
  const template = spec.pages.find((p) => p.rects.length > 0);
  if (!template) return [];
  return template.rects
    .map((r) => clampRect(r, template.pageWidth, template.pageHeight))
    .filter((r): r is ExcludeRect => r !== null);
}

/** Total number of rects that will actually be applied. */
export function countRects(spec: ExcludeRegions | null | undefined): number {
  if (!spec || spec.pages.length === 0) return 0;
  return spec.pages.reduce(
    (sum, page) => sum + (page.rects.length > 0 ? page.rects.length : 0),
    0,
  );
}

/** Replace (or remove, when empty) one page's rects. */
export function withPageRects(
  spec: ExcludeRegions,
  page: PageExclude,
): ExcludeRegions {
  const rest = spec.pages.filter((p) => p.page !== page.page);
  return {
    ...spec,
    pages:
      page.rects.length > 0
        ? [...rest, page].sort((a, b) => a.page - b.page)
        : rest,
  };
}
