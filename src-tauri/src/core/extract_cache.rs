use std::sync::Mutex;

use pdf_inspector::{PdfError, TextItem};

use crate::core::grid_rebuild;
use crate::core::grid_rebuild::LineMeta;

/// The reusable result of a full-document extraction.
#[derive(Debug, Clone)]
pub struct FullExtraction {
  /// Rebuilt markdown per page (1-indexed order), with visual line recovery.
  pub page_markdowns: Vec<String>,
  /// Per-page line geometry, parallel to `page_markdowns` (one [`LineMeta`]
  /// per non-empty output line; empty for pages whose markdown was not rebuilt
  /// from items, i.e. table pages / OCR pages). Feeds the paragraph-join
  /// policy (`core/paragraph.rs`) so switching the policy never re-decodes.
  pub line_meta: Vec<Vec<LineMeta>>,
  /// Per-page `needs_ocr` flags from pdf-inspector, in document order.
  pub needs_ocr_flags: Vec<bool>,
  /// 1-indexed pages where tables were detected.
  pub pages_with_tables: Vec<u32>,
  /// 1-indexed pages where multi-column layout was detected.
  pub pages_with_columns: Vec<u32>,
  /// True if any page has tables or columns.
  pub is_complex: bool,
  /// Positioned text items used by line-draw table extraction.
  pub items: Vec<TextItem>,
}

/// Full-document extraction cache: a single slot holds the decoded document
/// for the currently open PDF.
///
/// Extraction (font `/ToUnicode` CMap + content-stream decoding) is the
/// dominant cost of a conversion, and the same document is decoded once by
/// detection and again by conversion. This cache makes a detect>convert
/// sequence decode the document a single time instead of twice. Switching
/// files evicts the previous document.
///
/// The cache is a single slot (matching the previous line-draw cache) to bound
/// memory to one full document. With a batch concurrency above 1 the slot
/// thrashes between files and falls back to re-extraction (correct, just not
/// cached).
struct CacheEntry {
  path: String,
  separator: String,
  extraction: FullExtraction,
}

static CACHE: Mutex<Option<CacheEntry>> = Mutex::new(None);

/// Return the full-document extraction for `path`. The first call per file
/// decodes the whole document and populates the cache; later calls clone the
/// cached copy. When `use_cache` is `false` the cache is neither read nor
/// written, so callers that opted out of caching re-extract every time.
///
/// `separator` (the "text separator" setting) is baked into the per-page
/// markdown, so the cache is keyed by path + separator: a change of separator
/// re-extracts the document instead of serving stale joins.
pub fn cached_extraction(
  path: &str,
  use_cache: bool,
  separator: &str,
) -> Result<FullExtraction, PdfError> {
  if !use_cache {
    return extract_fresh(path, separator);
  }

  let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
  if let Some(entry) = guard.as_ref() {
    if entry.path == path && entry.separator == separator {
      return Ok(entry.extraction.clone());
    }
  }

  let extraction = extract_fresh(path, separator)?;
  *guard = Some(CacheEntry {
    path: path.to_string(),
    separator: separator.to_string(),
    extraction: extraction.clone(),
  });
  Ok(extraction)
}

/// Return a clone of the cached text items for `path` without decoding
/// anything. `None` when the cache is empty or holds a different file.
pub fn peek_items(path: &str) -> Option<Vec<TextItem>> {
  let guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
  guard
    .as_ref()
    .filter(|entry| entry.path == path)
    .map(|entry| entry.extraction.items.clone())
}

fn extract_fresh(path: &str, separator: &str) -> Result<FullExtraction, PdfError> {
  let pages = pdf_inspector::extract_pages_markdown(path, None)?;
  let items = pdf_inspector::extract_text_with_positions(path)?;
  let page_texts =
    grid_rebuild::rebuild_pages(&pages.pages, &items, &pages.pages_with_tables, separator);
  let page_markdowns = page_texts.iter().map(|t| t.markdown.clone()).collect();
  let line_meta = page_texts
    .iter()
    .map(|t| t.line_meta.clone().unwrap_or_default())
    .collect();
  Ok(FullExtraction {
    page_markdowns,
    line_meta,
    needs_ocr_flags: pages.pages.iter().map(|p| p.needs_ocr).collect(),
    pages_with_tables: pages.pages_with_tables,
    pages_with_columns: pages.pages_with_columns,
    is_complex: pages.is_complex,
    items,
  })
}
