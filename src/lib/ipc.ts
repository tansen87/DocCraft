import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  ConvertResult,
  DetectResult,
  DrawTableRequest,
  DrawTableResult,
  HybridSessionInfo,
  MdAnalyzeResult,
  MdExportResult,
  OcrImageResult,
  OcrVendor,
  OcrVendorInput,
} from "./types";

export const detectPdf = (path: string) =>
  invoke<DetectResult>("detect_pdf", { path });

export const convertPdf = (path: string) =>
  invoke<ConvertResult>("convert_pdf", { path });

/** Begin a hybrid session: text pages extracted once, kept on the backend. */
export const startHybridSession = (path: string, ocrPages: number[]) =>
  invoke<HybridSessionInfo>("hybrid_session_start", { path, ocrPages });

/** Stream one rendered page through the OCR provider. */
export const hybridPageOcr = (
  sessionId: string,
  page: number,
  imagePng: string,
) => invoke<string>("hybrid_page_ocr", { sessionId, page, imagePng });

/** Reassemble text + OCR pages in document order. */
export const finishHybridSession = (sessionId: string) =>
  invoke<ConvertResult>("hybrid_session_finish", { sessionId });

/** Abandon a session (cancelled / failed before finishing). */
export const abortHybridSession = (sessionId: string) =>
  invoke<void>("hybrid_session_abort", { sessionId });

export const exportMarkdown = (path: string, content: string) =>
  invoke<void>("export_markdown", { path, content });

/** Convert one standalone image (PNG / JPEG) to Markdown via OCR. */
export const ocrImageToMd = (path: string) =>
  invoke<OcrImageResult>("ocr_image_to_md", { path });

export const getOcrConfig = () => invoke<OcrVendor[]>("get_ocr_config");

export const saveOcrConfig = (vendors: OcrVendorInput[]) =>
  invoke<void>("save_ocr_config", { vendors });

export const revealOcrKey = (vendorId: string) =>
  invoke<string | null>("reveal_ocr_key", { vendorId });

export const getAppSettings = () => invoke<AppSettings>("get_app_settings");

export const setAppSettings = (settings: AppSettings) =>
  invoke<void>("set_app_settings", { settings });

/** Analyze the tables contained in a Markdown file. */
export const analyzeMarkdown = (path: string) =>
  invoke<MdAnalyzeResult>("analyze_markdown", { path });

/** Export all tables of a Markdown file into an xlsx workbook. */
export const exportMarkdownTables = (mdPath: string, xlsxPath: string) =>
  invoke<MdExportResult>("export_markdown_tables", { mdPath, xlsxPath });

/** Extract tables from a PDF based on user-drawn lines. */
export const extractDrawTable = (path: string, drawData: DrawTableRequest) =>
  invoke<DrawTableResult>("extract_draw_table", { path, drawData });

/** Extract tables from user-drawn lines and merge into existing Markdown. */
export const extractDrawTableToMarkdown = (
  path: string,
  drawData: DrawTableRequest,
  existingMarkdown?: string,
) =>
  invoke<string>("extract_draw_table_to_markdown", {
    path,
    drawData,
    existingMarkdown: existingMarkdown ?? null,
  });
