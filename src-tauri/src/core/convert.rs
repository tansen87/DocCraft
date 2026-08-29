use std::time::Instant;

use pdf_inspector::PdfError;

use crate::core::extract_cache;
use crate::core::grid_rebuild;
use crate::models::{ConvertResult, DetectResult, ExcludeRegions};

/// Detect-only path: classification + per-page OCR routing signals.
///
/// Runs the real extraction so `pages_needing_ocr` reflects the actual pages
/// that would need OCR (detection-flagged plus image-only pages whose markdown
/// is empty) - the status bar shows this before any conversion. The extraction
/// is cached so a following conversion reuses it instead of decoding the
/// document again.
pub fn detect_pdf(
  path: &str,
  use_cache: bool,
  text_separator: &str,
) -> Result<DetectResult, PdfError> {
  let det = pdf_inspector::detect_pdf(path)?;
  let ext = extract_cache::cached_extraction(path, use_cache, text_separator)?;

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
///
/// When `page_range` is `Some`, only those pages participate in the output
/// (see [`grid_rebuild::rebuild_document_for_pages`]) while each keeps its
/// original document page number in its marker.
///
/// `exclusions` removes the content of user-drawn rectangles from the output
/// (see [`grid_rebuild::rebuild_pages_excluding`]).
///
/// `text_separator` joins the text items on a rebuilt visual line - the app's
/// "文本连接符" setting, kept consistent with the OCR engine (see
/// [`grid_rebuild::rebuild_pages`]).
pub fn convert_pdf(
  path: &str,
  use_cache: bool,
  page_range: Option<&str>,
  exclusions: Option<&ExcludeRegions>,
  text_separator: &str,
) -> Result<ConvertResult, PdfError> {
  let start = Instant::now();

  let det = pdf_inspector::detect_pdf(path)?;
  let ext = extract_cache::cached_extraction(path, use_cache, text_separator)?;

  let page_count = ext.page_markdowns.len() as u32;
  let target_pages = grid_rebuild::parse_page_range(page_range, page_count)
    .unwrap_or_else(|| (1..=page_count).collect());

  // Report the pages that truly need OCR (detection-flagged + image-only pages
  // whose extraction is empty), independent of the OCR toggle. Restricted to
  // the selected range so the status bar reflects what the conversion covers.
  let mut info = DetectResult::from(&det);
  let all_ocr = grid_rebuild::merge_ocr_pages(&info.pages_needing_ocr, &ext.page_markdowns);
  info.pages_needing_ocr = all_ocr
    .into_iter()
    .filter(|p| target_pages.contains(p))
    .collect();

  // A local-only conversion never runs OCR, so every page that needs it is
  // skipped - record them so the UI can surface them in the status bar.
  let skipped_pages = info.pages_needing_ocr.clone();

  // Exclusions are applied last: the OCR routing above is decided from the
  // unfiltered extraction, so a page emptied by an exclusion is not mistaken
  // for an image-only page that needs OCR.
  let page_markdowns = match exclusions {
    Some(spec) if !spec.pages.is_empty() => grid_rebuild::rebuild_pages_excluding(
      &ext.page_markdowns,
      &ext.items,
      &ext.pages_with_tables,
      &ext.needs_ocr_flags,
      spec,
      text_separator,
    ),
    _ => ext.page_markdowns.clone(),
  };
  let markdown = grid_rebuild::rebuild_document_for_pages(&page_markdowns, &target_pages);

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
