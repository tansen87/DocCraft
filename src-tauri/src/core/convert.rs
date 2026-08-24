use std::time::Instant;

use pdf_inspector::PdfError;

use crate::core::extract_cache;
use crate::core::grid_rebuild;
use crate::models::{ConvertResult, DetectResult};

/// Detect-only path: classification + per-page OCR routing signals.
///
/// Runs the real extraction so `pages_needing_ocr` reflects the actual pages
/// that would need OCR (detection-flagged plus image-only pages whose markdown
/// is empty) - the status bar shows this before any conversion. The extraction
/// is cached so a following conversion reuses it instead of decoding the
/// document again.
pub fn detect_pdf(path: &str, use_cache: bool) -> Result<DetectResult, PdfError> {
  let det = pdf_inspector::detect_pdf(path)?;
  let ext = extract_cache::cached_extraction(path, use_cache)?;

  let mut info = DetectResult::from(&det);
  info.pages_needing_ocr =
    grid_rebuild::merge_ocr_pages(&info.pages_needing_ocr, &ext.page_markdowns);
  Ok(info)
}

/// Full local conversion with visual line recovery.
///
/// The document is loaded and extracted once per stage: fast metadata-only
/// detection, per-page markdown + layout classification, and a second pass
/// with positioned items for line-break reconstruction. When `use_cache` is
/// on, the per-page markdowns and positioned items are reused from the shared
/// extraction cache (populated by an earlier detection of the same file).
pub fn convert_pdf(path: &str, use_cache: bool) -> Result<ConvertResult, PdfError> {
  let start = Instant::now();

  let det = pdf_inspector::detect_pdf(path)?;
  let ext = extract_cache::cached_extraction(path, use_cache)?;
  let markdown = grid_rebuild::rebuild_document_from_markdowns(ext.page_markdowns.clone());

  // Report the pages that truly need OCR (detection-flagged + image-only pages
  // whose extraction is empty), independent of the OCR toggle.
  let mut info = DetectResult::from(&det);
  info.pages_needing_ocr =
    grid_rebuild::merge_ocr_pages(&info.pages_needing_ocr, &ext.page_markdowns);

  // A local-only conversion never runs OCR, so every page that needs it is
  // skipped - record them so the UI can surface them in the status bar.
  let skipped_pages = info.pages_needing_ocr.clone();

  Ok(ConvertResult {
    info,
    markdown,
    processing_time_ms: start.elapsed().as_millis() as u64,
    skipped_pages,
    failed_pages: Vec::new(),
  })
}

/// Persist markdown content to an arbitrary user-chosen path.
pub fn export_markdown(path: &str, content: &str) -> Result<(), String> {
  std::fs::write(path, content).map_err(|e| e.to_string())
}
