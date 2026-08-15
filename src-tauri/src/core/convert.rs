use std::time::Instant;

use pdf_inspector::PdfError;

use crate::core::grid_rebuild;
use crate::models::{ConvertResult, DetectResult};

/// Detect-only path: classification + per-page OCR routing signals.
pub fn detect_pdf(path: &str) -> Result<DetectResult, PdfError> {
  pdf_inspector::detect_pdf(path).map(|r| DetectResult::from(&r))
}

/// Full local conversion with visual line recovery.
///
/// The document is loaded and extracted once per stage: fast metadata-only
/// detection, per-page markdown + layout classification, and a second pass
/// with positioned items for line-break reconstruction.
pub fn convert_pdf(path: &str) -> Result<ConvertResult, PdfError> {
  let start = Instant::now();

  let det = pdf_inspector::detect_pdf(path)?;
  let pages = pdf_inspector::extract_pages_markdown(path, None)?;
  let items = pdf_inspector::extract_text_with_positions(path)?;
  let markdown = grid_rebuild::rebuild_document(&pages.pages, &items, &pages.pages_with_tables);

  Ok(ConvertResult {
    info: DetectResult::from(&det),
    markdown,
    processing_time_ms: start.elapsed().as_millis() as u64,
  })
}

/// Persist markdown content to an arbitrary user-chosen path.
pub fn export_markdown(path: &str, content: &str) -> Result<(), String> {
  std::fs::write(path, content).map_err(|e| e.to_string())
}
