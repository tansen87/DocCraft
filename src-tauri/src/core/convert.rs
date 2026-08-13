use pdf_inspector::PdfError;

use crate::models::{ConvertResult, DetectResult};

/// Detect-only path: classification + per-page OCR routing signals.
pub fn detect_pdf(path: &str) -> Result<DetectResult, PdfError> {
  pdf_inspector::detect_pdf(path).map(|r| DetectResult::from(&r))
}

/// Full local conversion (detect → extract → markdown).
pub fn convert_pdf(path: &str) -> Result<ConvertResult, PdfError> {
  pdf_inspector::process_pdf(path).map(|r| ConvertResult::from(&r))
}

/// Persist markdown content to an arbitrary user-chosen path.
pub fn export_markdown(path: &str, content: &str) -> Result<(), String> {
  std::fs::write(path, content).map_err(|e| e.to_string())
}
