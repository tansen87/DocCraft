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
}

export interface OcrModel {
  id: string;
  name: string;
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
}

/** Global app settings persisted by the backend. */
export interface AppSettings {
  /** Max concurrent batch conversions (1–16). */
  maxConcurrent: number;
}

/** A single GitHub-Flavored Markdown table parsed by the backend. */
export interface MdTable {
  columns: string[];
  rows: string[][];
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