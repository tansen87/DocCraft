export type PdfType = "TextBased" | "Scanned" | "ImageBased" | "Mixed";

export interface LayoutInfo {
  isComplex: boolean;
  pagesWithTables: number[];
  pagesWithColumns: number[];
}

export interface DetectResult {
  pdfType: PdfType;
  confidence: number;
  pageCount: number;
  pagesNeedingOcr: number[];
  title: string | null;
  hasEncodingIssues: boolean;
  layout: LayoutInfo;
}

export interface ConvertResult extends DetectResult {
  markdown: string;
  processingTimeMs: number;
  /** 1-indexed pages that needed OCR but were skipped (no OCR provider configured). */
  skippedPages: number[];
  /** 1-indexed pages whose OCR request failed (degraded to a placeholder comment). */
  failedPages: number[];
  /** Average confidence (0..1) of the local PaddleOCR results; absent for pure-text / AI / disabled conversions. */
  ocrConfidence?: number | null;
}

export interface OcrModel {
  id: string;
  name: string;
  /** Whether this is the model used for OCR when the vendor is selected. */
  default: boolean;
}

/** OCR vendor as loaded from the backend (never includes the secret). */
export interface OcrVendor {
  id: string;
  name: string;
  baseUrl: string;
  /** Whether a key is already stored for this vendor. */
  apiKeySet: boolean;
  models: OcrModel[];
}

/** Payload sent when saving OCR config. */
export interface OcrVendorInput {
  id: string;
  name: string;
  baseUrl: string;
  /** New key to store; empty string keeps the previously stored key. */
  apiKey: string;
  /** Set to true to remove the stored key for this vendor. */
  clearApiKey: boolean;
  models: OcrModel[];
}

/** A page rendered to PNG (base64) that must go through OCR. */
export interface OcrPageImage {
  /** 1-indexed page number in document order. */
  page: number;
  imagePng: string;
}

/** Returned by `startHybridSession`: session id + detection info. */
export interface HybridSessionInfo extends DetectResult {
  sessionId: string;
  /** Whether a usable OCR provider was resolved. When false, OCR pages are skipped. */
  ocrConfigured: boolean;
}

/** Global app settings persisted by the backend. */
export interface AppSettings {
  /** Max concurrent batch conversions (1–16). */
  maxConcurrent: number;
  /**
   * Cache decoded line-draw text items per document so repeated extractions
   * reuse the font/CMap + content-stream decode. Costs memory (one full
   * document decode stays resident); turn off for very large documents.
   */
  cacheExtractedText: boolean;
  /**
   * Only export the GFM tables when converting Markdown to Excel; when false,
   * the whole document content (tables and plain text) is written into the
   * workbook.
   */
  excelTablesOnly: boolean;
  /**
   * OCR mode: controls when and how OCR is performed.
   *  - forceOcr: OCR every page regardless of text extraction.
   *  - nonTextOnly: OCR only pages with no extracted text.
   *  - disabled: skip OCR entirely.
   *  - local: use local PaddleOCR engine.
   *  - ai: use remote AI vision providers.
   */
  ocrMode: OcrMode;
  /** Global hotkey starting screenshot recognition (e.g. "F8"); null/empty disables. */
  screenshotHotkey?: string | null;
  /** Whether to show the system tray icon. */
  enableTray: boolean;
  /**
   * Low-precision (f16) MNN inference for the local PaddleOCR engine -
   * ~30–50% faster on CPU with negligible accuracy loss (default true).
   */
  ocrLowPrecision?: boolean;
  /**
   * Which local PaddleOCR model tier to load (default "small").
   * "tiny" is the fastest, "medium" prioritizes accuracy.
   */
  ocrModelSize?: OcrModelSize;
  /**
   * High-precision draw-table extraction on scanned pages: renders OCR page
   * images at a higher DPI (~288 vs ~180) and cuts recognized text by
   * width-weighted character centers. More accurate column boundaries,
   * slower and more memory-hungry (default false).
   */
  drawTableHighPrecision?: boolean;
  /** Separator between text blocks within a single OCR line. */
  textSeparator: string;
  /**
   * Paragraph line-break policy for PDF text pages and OCR pages:
   *  - "keep": one Markdown line per visual line (original behaviour).
   *  - "smart": merge soft line breaks inside a paragraph (recommended).
   *  - "none": merge every non-structural line of a page into one.
   */
  paragraphMode?: ParagraphMode;
  /** Show a result popup after every screenshot recognition (default true). */
  snipResultPopup?: boolean;
  /** Auto-copy the screenshot recognition result to the clipboard (default true). */
  snipAutoCopy?: boolean;
  /**
   * Glassmorphism background opacity for the snip result window (0–100, default 60).
   * 0 = fully transparent, 100 = fully opaque.
   */
  snipResultOpacity?: number;
  /**
   * Glassmorphism background opacity for the main window (0–100, default 100).
   * 0 = fully transparent, 100 = fully opaque.
   */
  mainWindowOpacity?: number;
  /**
   * Enable the frosted-glass blur effect on the main and result windows
   * (default true).
   */
  glassBlurEnabled?: boolean;
  /**
   * Custom prompt for the remote AI document-OCR path (PDF pages, images,
   * screenshots). Empty string falls back to the built-in default prompt.
   */
  aiOcrPrompt?: string;
  /**
   * Custom prompt for the remote AI draw-table path (image / PDF line-draw
   * extraction). Empty string falls back to the built-in default prompt.
   */
  drawTablePrompt?: string;
  /**
   * Number of inference threads for the local PaddleOCR engine (MNN).
   * 0 = auto-detect from available parallelism (default).
   * Positive values use the user's explicit choice (clamped to 1–16).
   */
  localOcrThreads?: number;
}

export type OcrMode =
  | "forceLocal"
  | "forceAi"
  | "nonTextLocal"
  | "nonTextAi"
  | "disabled";

/** Local PaddleOCR model tier (files bundled under resources/ppocr). */
export type OcrModelSize = "tiny" | "small" | "medium";

/**
 * Paragraph line-break policy (backend `ParagraphMode`):
 *  - "keep": one Markdown line per visual line (original behaviour).
 *  - "smart": merge soft line breaks inside a paragraph.
 *  - "none": merge every non-structural line of a page into one.
 *  - "guided": merge only within the user-selected table columns (00015).
 */
export type ParagraphMode = "keep" | "smart" | "none" | "guided";

/**
 * User-specified column-merge configuration for the `guided` paragraph mode
 * (docs/design/00015_guided-paragraph-mode.md).
 */
export interface GuidedMergeConfig {
  /** Vertical line x-coordinates (page pixels, ascending). Optional - the
   *  enclosing request usually already carries the percentage-based lines. */
  verticalLines?: number[];
  /** Record boundaries (y-coordinates, ascending); same as horizontal rows. */
  horizontalLines?: number[];
  /** Indices (0-based, left→right) of the columns whose wrapped lines merge. */
  mergeColumns: number[];
}

/** A single GitHub-Flavored Markdown table parsed by the backend. */
export interface MdTable {
  columns: string[];
  rows: string[][];
  /** Source PDF page (1-indexed) when the table came from this app's PDF→Markdown conversion. */
  page: number | null;
}

/** Result of analyzing the tables in a Markdown file. */
export interface MdAnalyzeResult {
  tableCount: number;
  tables: MdTable[];
  totalRows: number;
  /** Total number of lines in the whole file (tables, prose and blanks). */
  totalLines: number;
  processingTimeMs: number;
  /** Full raw markdown content of the file (for the rendered/raw preview). */
  content: string;
}

/** Result of exporting Markdown tables to an xlsx workbook. */
export interface MdExportResult {
  tableCount: number;
  totalRows: number;
  processingTimeMs: number;
}

// ─── Line-draw table extraction types ────────────────────────────────────

/** A single rectangular region drawn by the user. */
export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Per-page draw-table definition sent to the backend. */
export interface PageDrawTable {
  page: number;
  horizontalLines: number[];
  verticalLines: number[];
  rectangles?: RegionRect[];
  /** Column indices (0-based) whose wrapped text merges (00015 guided). */
  mergeColumns?: number[];
  /** Page origin (x, y of lower-left corner) in PDF points, from pdfjs rawDims. */
  pageX: number;
  pageY: number;
  /** Page width/height in PDF points (without userUnit scaling), from pdfjs rawDims. */
  pageWidth: number;
  pageHeight: number;
}

// ─── Exclusion regions (see docs/design/00010_pdf-exclude-region.md) ──────

/**
 * A rectangle whose content must not take part in recognition, expressed in
 * **viewport-relative PDF points with the origin at the lower-left corner**.
 */
export interface ExcludeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One page's exclusion rects plus the page geometry from pdfjs `rawDims`. */
export interface PageExclude {
  /** 1-indexed page number. */
  page: number;
  rects: ExcludeRect[];
  /** Page origin (x, y of lower-left corner) in PDF points. */
  pageX: number;
  pageY: number;
  pageWidth: number;
  pageHeight: number;
}

/** Exclusion payload sent with a conversion. */
export interface ExcludeRegions {
  pages: PageExclude[];
  /** Apply the rects of the first page carrying any to every page. */
  useForAllPages?: boolean;
  totalPages?: number;
}

/** Per-page geometry of a document, captured when exclusion mode is entered. */
export interface PageGeometry {
  pageX: number;
  pageY: number;
  pageWidth: number;
  pageHeight: number;
  /** `page.rotate` of the pdf.js page; non-zero pages cannot carry rects yet. */
  rotation: number;
}

/** A page rendered to PNG (base64) for the draw-table local OCR fallback. */
export interface PageImagePayload {
  /** 1-indexed page number. */
  page: number;
  /** PNG bytes encoded as base64. */
  imagePng: string;
  /** Scale (pixels per PDF point) at which the PNG was rendered. */
  renderScale: number;
}

/** Request payload for the draw-table extraction command. */
export interface DrawTableRequest {
  pages: PageDrawTable[];
  /**
   * When true, the lines drawn on one page are applied to every page of the
   * document instead of only the pages listed in `pages`.
   */
  useForAllPages?: boolean;
  /**
   * When `useForAllPages` is set, restrict extraction to the first `maxPages`
   * pages (e.g. a quick preview of the first 5 pages to verify the drawn
   * lines). When omitted, all pages are extracted.
   */
  maxPages?: number;
  /**
   * Total page count of the document. Only needed for apply-to-all-pages
   * extractions of documents without any text layer, where the page count
   * cannot be derived from extracted text items.
   */
  totalPages?: number;
  /**
   * Restrict processing to these 1-indexed pages. Used to batch large OCR
   * extractions into several requests.
   */
  onlyPages?: number[];
  /**
   * Rendered page images for the local PaddleOCR fallback. Pages with a text
   * layer never touch these; an image is consumed only when its page has no
   * extractable text at all.
   */
  pageImages?: PageImagePayload[];
  /**
   * Regions whose content must not be recognized. The rects are
   * viewport-relative PDF points, i.e. the same space `pages[].pageX/pageY`
   * describe, so the backend compares them without any further shift.
   */
  exclusions?: ExcludeRegions | null;
}

/** Metadata about where a table was extracted from. */
export interface TableRegionInfo {
  page: number;
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

/** Result of extracting tables from user-drawn lines. */
export interface DrawTableResult {
  tableCount: number;
  tables: MdTable[];
  regions: TableRegionInfo[];
  totalRows: number;
  processingTimeMs: number;
  /** 1-indexed pages whose content came from the local PaddleOCR fallback. */
  ocrPages: number[];
  /** 1-indexed pages that had no text layer and no usable OCR result. */
  emptyTextPages: number[];
  /** Average confidence (0..1) of the local PaddleOCR fallback; absent for pure text / AI / disabled. */
  ocrConfidence?: number | null;
}

// ─── Frontend-only types for the canvas overlay ──────────────────────────

/** Line types for the draw-table canvas overlay. */
export type DrawLineType = "horizontal" | "vertical" | "rectangle";

/** A single line drawn on the canvas overlay. */
export interface DrawLine {
  id: string;
  type: DrawLineType;
  /** In PDF user-space coordinates */
  pdfValue: number;
  /** In canvas (CSS pixel) coordinates */
  canvasValue: number;
  color: string;
}

/** A rectangle drawn on the canvas overlay. */
export interface DrawRect {
  id: string;
  type: "rectangle";
  /** In PDF user-space coordinates */
  pdfX: number;
  pdfY: number;
  pdfWidth: number;
  pdfHeight: number;
  /** In canvas (CSS pixel) coordinates */
  canvasX: number;
  canvasY: number;
  canvasWidth: number;
  canvasHeight: number;
  color: string;
}

/** Canvas overlay element - either a line or a rectangle. */
export type CanvasElement = DrawLine | DrawRect;

/** Mode for the canvas overlay interaction. */
export type DrawMode =
  | "horizontal"
  | "vertical"
  | "rectangle"
  | "select"
  | "merge";

/**
 * Active tool inside the draw-table surface. Line tools place separators on
 * click; the exclude tool hands the pointer to the exclusion-region editor
 * (same store as the normal-mode editor), so both orders of "draw lines first"
 * and "exclude area first" work on the same page. `merge` (00015 guided mode)
 * toggles which columns merge their wrapped lines.
 */
export type DrawTool = "vertical" | "horizontal" | "exclude" | "merge";

// ─── Status bar activity & notices ───────────────────────────────────────

/** Long-running task phase reported by the status bar progress indicator. */
export type ActivityPhase = "extract" | "ocr" | "imageOcr";

export interface ActivityProgress {
  phase: ActivityPhase;
  /** Pages completed so far (omit for an indeterminate task). */
  current?: number;
  /** Total pages of this phase (when determinate). */
  total?: number;
}

export type NoticeLevel = "info" | "warning" | "error";

/** An action button rendered inside a status bar notice. */
export interface StatusNoticeAction {
  label: string;
  onClick: () => void;
}

/** A structured notification shown in the status bar bell popover. */
export interface StatusNotice {
  /** Stable id - used for read/dismissed tracking across renders. */
  id: string;
  level: NoticeLevel;
  text: string;
  /**
   * Page numbers rendered as clickable chips. Clicking one invokes
   * `onPageClick` (e.g. to jump the preview to that page).
   */
  pages?: number[];
  onPageClick?: (page: number) => void;
  actions?: StatusNoticeAction[];
}

// ─── Image → Markdown ────────────────────────────────────────────────────

/** Backend result of converting one standalone image to Markdown. */
export interface OcrImageResult {
  markdown: string;
  /** Which engine produced the result: `"local"` or `"ai"`. */
  engine: "local" | "ai";
  durationMs: number;
  /**
   * Base64 PNG of the recognized region - only set by the screenshot
   * pipeline so the frontend can thumbnail without touching disk.
   */
  pngBase64?: string;
  /** Saved screenshot copy path (screenshot pipeline only), enabling retry. */
  savedPath?: string;
  /**
   * Stage timings in ms (screenshot pipeline only, S-6 in
   * docs/design/00005_snip-local-ocr-latency.md): region crop + thumbnail,
   * OCR inference, and full-res PNG persist.
   */
  cropMs?: number;
  inferMs?: number;
  saveMs?: number;
  /** Average confidence (0..1) of the local PaddleOCR recognition; absent for AI vision. */
  ocrConfidence?: number | null;
}

/** One captured monitor snapshot offered to the snip overlay windows. */
export interface MonitorSnapshot {
  id: number;
  /** Physical position of the monitor on the desktop. */
  x: number;
  y: number;
  /** Physical size of the captured frame. */
  width: number;
  height: number;
  /** OS DPI scale factor (`css_px = physical_px / scale`). */
  scaleFactor: number;
  /** `data:image/png;base64,...` snapshot shown as the overlay background. */
  dataUrl: string;
}

/** A user-dragged rectangle inside one monitor, in **physical pixels**. */
export interface ShotRegion {
  monitorId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Request to extract a table from an image using drawn lines. */
export interface ImageTableRequest {
  imagePath: string;
  /** Vertical line positions as percentages of the image width (0-100). */
  verticalLines: number[];
  /**
   * Horizontal line positions as percentages of the image height (0-100).
   * When present and non-empty, rows are cut at these boundaries instead of
   * being auto-grouped from OCR block positions.
   */
  horizontalLines?: number[];
  /** Guided column-merge config (00015); only when guided mode is active. */
  guided?: GuidedMergeConfig;
}

/** Result of extracting a table from an image with drawn lines. */
export interface ImageTableResult {
  markdown: string;
  engine: "local" | "ai";
  durationMs: number;
}

/** Information about the top-level window currently under the cursor. */
export interface WindowInfo {
  title: string;
  className: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// ─── Config import / export & update check ───────────────────────────────

/** Summary of a configuration import (for the success toast). */
export interface ConfigImportResult {
  vendorsImported: number;
  settingsApplied: boolean;
}

/** A release found by the update check (GitHub Releases API). */
export interface UpdateInfo {
  /** Version without the leading `v` (parsed from `tag_name`). */
  version: string;
  /** Release title. */
  title: string;
  /** Release notes markdown. */
  notes: string;
  /** Release page URL. */
  url: string;
  /** Whether this release is strictly newer than the running app version. */
  isNewer: boolean;
}

// ─── Local usage statistics ───────────────────────────────────────────────

/** What kind of operation produced a usage log entry. */
export type UsageKind =
  | "pdf"
  | "drawTable"
  | "imageTable"
  | "image"
  | "screenshot";

/** One usage event appended to the local JSONL log (`record_usage`). */
export interface UsageInput {
  kind: UsageKind;
  /** Files involved (normally 1 - one entry per operation). */
  fileCount: number;
  /** Pages involved (1 for a single image / screenshot). */
  pageCount: number;
  /** Pages that actually went through OCR. */
  ocrPageCount: number;
  /** OCR engine used: `"local"` (PaddleOCR) or `"ai"` (remote vision); null when no OCR ran. */
  engine?: "local" | "ai" | null;
  /** Wall-clock duration of the whole operation in milliseconds. */
  totalMs: number;
  /** Local calendar date (`YYYY-MM-DD`) when the operation happened. */
  date: string;
}

/** Aggregated counters for one time period (read-only Settings card). */
export interface UsagePeriodStats {
  /** Total files (PDF + images combined). */
  fileCount: number;
  /** Total pages (PDF pages; each image / screenshot counts as 1). */
  pageCount: number;
  /** Pages that went through OCR (PDF OCR pages + one per image / screenshot). */
  ocrPageCount: number;
  /** Total wall-clock time of all operations in milliseconds. */
  totalMs: number;
  /** PDF files (kinds `pdf` / `drawTable`). */
  pdfFileCount: number;
  /** PDF document pages converted or extracted. */
  pdfPageCount: number;
  /** PDF pages that went through OCR (the true "scan ratio"). */
  pdfOcrPageCount: number;
  /** Image files (kinds `image` / `screenshot` / `imageTable`). */
  imageFileCount: number;
  /** OCR pages handled by the local PaddleOCR engine. */
  localOcrPageCount: number;
  /** OCR pages handled by the remote AI vision engine. */
  aiOcrPageCount: number;
}

/** Read-only aggregate shown in Settings (`get_usage_stats`). */
export interface UsageStats {
  month: UsagePeriodStats;
  today: UsagePeriodStats;
  total: UsagePeriodStats;
}
