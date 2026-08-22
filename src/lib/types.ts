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
}

export type OcrMode =
  | "forceLocal"
  | "forceAi"
  | "nonTextLocal"
  | "nonTextAi"
  | "disabled";

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
  processingTimeMs: number;
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
  /** Page origin (x, y of lower-left corner) in PDF points, from pdfjs rawDims. */
  pageX: number;
  pageY: number;
  /** Page width/height in PDF points (without userUnit scaling), from pdfjs rawDims. */
  pageWidth: number;
  pageHeight: number;
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

/** Canvas overlay element — either a line or a rectangle. */
export type CanvasElement = DrawLine | DrawRect;

/** Mode for the canvas overlay interaction. */
export type DrawMode = "horizontal" | "vertical" | "rectangle" | "select";

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
  /** Stable id — used for read/dismissed tracking across renders. */
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
}
