use std::collections::{HashMap, HashSet};
use std::time::Instant;

use pdf_inspector::TextItem;
use pdf_inspector::extractor::ItemType;

use crate::core::extract_cache;
use crate::core::md_to_xlsx::parse_md_tables;
use crate::core::ocr::{LocalOcrEngine, OcrRecognition, RemoteOcrProvider};
use crate::core::page_marker::page_marker;
use crate::core::region_exclude;
use crate::models::{
  DrawTableRegion, DrawTableRequest, DrawTableResult, MdTable, PageDrawTable, PageImagePayload,
  RegionRect, TableRegionInfo,
};

/// OCR engines available for the draw-table fallback. The caller resolves at
/// most one provider, matching the user's selected OCR mode: local PaddleOCR
/// for `forceLocal` / `nonTextLocal`, remote AI vision for `forceAi` /
/// `nonTextAi`, none for `disabled`.
pub struct DrawOcrEngines<'a> {
  pub local: Option<&'a LocalOcrEngine>,
  pub remote: Option<&'a RemoteOcrProvider>,
  /// Base prompt for the remote AI vision table path, resolved from settings
  /// (the empty string falls back to the built-in default). Only meaningful
  /// when `remote` is `Some`.
  pub remote_prompt: &'a str,
}

/// A text element extracted from a PDF page with its position.
#[derive(Debug, Clone)]
struct TextElement {
  text: String,
  /// PDF user-space x coordinate (origin at bottom-left)
  x: f64,
  /// PDF user-space y coordinate (origin at bottom-left)
  y: f64,
  /// Estimated width in PDF user space
  width: f64,
  /// Font size (in PDF points)
  font_size: f64,
}

/// Extract positioned text items from the PDF via pdf-inspector, which decodes
/// each font through its `/ToUnicode` CMap (unlike raw byte decoding, so CJK
/// content is recovered correctly). Images and links are excluded.
///
/// `page_filter` restricts extraction to those 1-indexed pages (text on other
/// pages is not decoded). This is the main cost of a line-draw extraction -
/// font CMap + content-stream decoding scales with the number of pages decoded,
/// so skipping pages we do not process keeps previews and single-page work fast.
fn extract_text_elements(
  path: &str,
  page_filter: Option<&HashSet<u32>>,
) -> Result<Vec<TextItem>, String> {
  pdf_inspector::extract_text_with_positions_pages(path, page_filter)
    .map_err(|e| format!("Text extraction failed: {e}"))
}

/// Map pdf-inspector text items onto the local element type, keeping only
/// text content on the given page.
fn to_text_elements(items: &[TextItem], page_num: u32) -> Vec<TextElement> {
  items
    .iter()
    .filter(|it| {
      it.page == page_num && matches!(it.item_type, ItemType::Text | ItemType::FormField)
    })
    .map(|it| TextElement {
      text: it.text.clone(),
      x: it.x as f64,
      y: it.y as f64,
      width: it.width as f64,
      font_size: it.font_size as f64,
    })
    .collect()
}

/// Map recognized OCR blocks from image pixel space into the same
/// viewport-relative PDF point space the drawn lines use.
///
/// The PNG covers exactly the pdf.js viewport area whose lower-left corner is
/// the viewBox origin `(page_x, page_y)`, so no further origin shift is needed:
/// x simply scales by `1 / render_scale`, and y flips from a top-left pixel
/// origin to the bottom-left PDF origin relative to that corner.
fn ocr_blocks_to_elements(recognition: &OcrRecognition, render_scale: f64) -> Vec<TextElement> {
  recognition
    .blocks
    .iter()
    .map(|b| {
      let x = b.left / render_scale;
      let width = b.width / render_scale;
      // Approximate height as the font size, mirroring how text elements use
      // font_size as their vertical extent in region overlap checks.
      let font_size = (b.height / render_scale).max(1.0);
      let y = (recognition.height_px as f64 - (b.top + b.height)) / render_scale;
      TextElement {
        text: b.text.clone(),
        x,
        y,
        width,
        font_size,
      }
    })
    .collect()
}

/// Run local PaddleOCR on one rendered page image and return positioned text
/// elements ready for the column-cutting pipeline, plus the page's average
/// recognition confidence (0..1).
fn ocr_text_elements(
  engine: &LocalOcrEngine,
  payload: &PageImagePayload,
) -> Result<(Vec<TextElement>, f32), String> {
  let png = base64::Engine::decode(
    &base64::engine::general_purpose::STANDARD,
    &payload.image_png,
  )
  .map_err(|e| format!("Failed to decode base64 image: {e}"))?;
  if payload.render_scale <= 0.0 {
    return Err("Invalid render scale for OCR page image".to_string());
  }
  let recognition = engine.recognize_png_blocks(&png)?;
  let confidence = recognition.confidence;
  let elements = ocr_blocks_to_elements(&recognition, payload.render_scale);
  Ok((elements, confidence))
}

/// Convert point-space line positions into percentages of the rendered
/// image dimension, so drawn separators can be described to a remote vision
/// model that has no notion of PDF coordinates.
fn line_percentages(lines_pts: &[f64], render_scale: f64, dimension_px: u32) -> Vec<f64> {
  if dimension_px == 0 || render_scale <= 0.0 {
    return Vec::new();
  }
  lines_pts
    .iter()
    .map(|pt| ((pt * render_scale / dimension_px as f64) * 100.0).clamp(0.0, 100.0))
    .collect()
}

/// Send one rendered page to the remote AI vision provider with the drawn
/// separator positions as hints, and parse the GFM answer back into tables.
///
/// The vision model returns structured markdown directly (no coordinates), so
/// this path bypasses the geometric column-cutting pipeline entirely.
fn ai_tables_for_page(
  provider: &RemoteOcrProvider,
  prompt: &str,
  payload: &PageImagePayload,
  page_draw: &PageDrawTable,
) -> Result<Vec<MdTable>, String> {
  let png = base64::Engine::decode(
    &base64::engine::general_purpose::STANDARD,
    &payload.image_png,
  )
  .map_err(|e| format!("Failed to decode base64 image: {e}"))?;
  let image = image::load_from_memory(&png).map_err(|e| format!("Failed to load image: {e}"))?;
  if payload.render_scale <= 0.0 {
    return Err("Invalid render scale for OCR page image".to_string());
  }

  let vertical_pcts = line_percentages(
    &page_draw.vertical_lines,
    payload.render_scale,
    image.width(),
  );
  let horizontal_pcts = line_percentages(
    &page_draw.horizontal_lines,
    payload.render_scale,
    image.height(),
  );

  // The command runs on a blocking worker thread; bridge into the async
  // runtime for the HTTP call.
  let markdown = tauri::async_runtime::block_on(crate::core::ocr::ai_recognize_table(
    provider,
    page_draw.page,
    &payload.image_png,
    &vertical_pcts,
    &horizontal_pcts,
    prompt,
  ))?;

  Ok(
    parse_md_tables(&markdown)
      .into_iter()
      .filter(|t| !t.columns.is_empty())
      .collect(),
  )
}

/// Filter text elements that fall within a given rectangular region.
/// The region is defined in PDF user space coordinates.
fn filter_text_by_region(elements: &[TextElement], region: &DrawTableRegion) -> Vec<TextElement> {
  elements
    .iter()
    .filter(|e| {
      // Check if element bounding box overlaps with the region
      let e_right = e.x + e.width;
      let e_top = e.y + e.font_size; // approximate height
      let r_right = region.x + region.width;
      let r_top = region.y + region.height;

      // Overlap check
      e.x < r_right && e_right > region.x && e.y < r_top && e_top > region.y
    })
    .cloned()
    .collect()
}

/// Elements with the excluded parts removed.
///
/// The inverse of [`filter_text_by_region`], and deliberately not a whole
/// element drop: pdf-inspector merges a visual line into one element, so a
/// band over a single column would otherwise erase the entire row. Splitting
/// keeps each piece at the x it occupied, and the drawn vertical lines then
/// still assign it to its original column instead of shifting the right-hand
/// columns one slot left.
///
/// Elements are already viewport-relative, so the rects (from
/// [`region_exclude::rects_for_page`]) are compared as they are.
fn filter_elements(rects: &[RegionRect], elements: Vec<TextElement>) -> Vec<TextElement> {
  let mut out = Vec::with_capacity(elements.len());
  for e in elements {
    for (x, width, text) in
      region_exclude::split_box_outside(rects, e.x, e.y, e.width, e.font_size, &e.text)
    {
      out.push(TextElement {
        text,
        x,
        y: e.y,
        width,
        font_size: e.font_size,
      });
    }
  }
  out
}

/// Build a list of column boundaries from vertical lines.
/// Returns sorted x values with implicit left (0) and right (page_width) boundaries.
fn build_col_boundaries(vertical_lines: &[f64], page_width: f64) -> Vec<f64> {
  let mut boundaries: Vec<f64> = vertical_lines.to_vec();
  boundaries.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
  boundaries.dedup();
  let mut result = vec![0.0];
  result.extend(boundaries);
  result.push(page_width);
  result
}

/// Group text elements by their y-coordinate (text lines).
/// Elements on the same text line have y-coordinates within a threshold.
fn group_by_text_lines(elements: &[TextElement]) -> Vec<Vec<&TextElement>> {
  if elements.is_empty() {
    return Vec::new();
  }

  let mut sorted: Vec<&TextElement> = elements.iter().collect();
  // Sort by y descending (top to bottom in PDF coords) and then x ascending
  sorted.sort_by(|a, b| {
    b.y
      .partial_cmp(&a.y)
      .unwrap_or(std::cmp::Ordering::Equal)
      .then_with(|| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
  });

  let mut lines: Vec<Vec<&TextElement>> = Vec::new();
  let mut current_line: Vec<&TextElement> = vec![sorted[0]];
  let mut current_y = sorted[0].y;

  for elem in &sorted[1..] {
    // Use a conservative threshold: 0.4x font size, minimum 3pt.
    // This is significantly smaller than typical line spacing (1.2x-1.5x font size),
    // so lines of text should NOT be merged, while elements on the same visual line
    // (with slight y-offset due to baseline shift or font metrics) WILL be grouped.
    let threshold = (elem.font_size * 0.4).max(3.0);
    if (elem.y - current_y).abs() < threshold {
      current_line.push(elem);
    } else {
      // Sort current line by x ascending
      current_line.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
      lines.push(current_line);
      current_line = vec![*elem];
      current_y = elem.y;
    }
  }

  if !current_line.is_empty() {
    current_line.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
    lines.push(current_line);
  }

  lines
}

/// Relative advance width of a character for center estimation, expressed in
/// half-width cells. CJK ideographs, Hangul, Kana and full-width forms are
/// double-width; everything else (ASCII digits, Latin letters, spaces,
/// punctuation) is single-width. This mirrors how OCR-detected runs of mixed
/// Chinese/digit text actually distribute their width - far better than the
/// uniform per-character advance used for plain text-layer items.
fn char_weight(c: char) -> f64 {
  let u = c as u32;
  let wide = matches!(u,
    0x1100..=0x115F     // Hangul Jamo
    | 0x2E80..=0xA4CF   // CJK radicals .. Yi syllables (incl. Kana)
    | 0xAC00..=0xD7A3   // Hangul syllables
    | 0xF900..=0xFAFF   // CJK compatibility ideographs
    | 0xFE30..=0xFE4F   // CJK compatibility forms
    | 0xFF00..=0xFF60   // full-width forms
    | 0xFFE0..=0xFFE6   // full-width signs
    | 0x20000..=0x3FFFD // CJK extensions B and beyond
  );
  if wide { 2.0 } else { 1.0 }
}

/// Extract the portion of a text line that falls inside the column `[left, right)`.
///
/// pdf-inspector merges same-style items on a line into a single item when the
/// gaps between them are small, so a dense (borderless) table row often arrives
/// as ONE item whose center would land in a single column. Instead of assigning
/// whole items by center, estimate each character's x position from the item's
/// advance width and keep the characters whose centers fall inside the column.
///
/// When `high_precision` is set, characters are weighted by their relative
/// width (CJK = 2 half-width cells) before distributing the item's advance -
/// this keeps mixed Chinese/digit rows aligned with the drawn boundaries even
/// when the item comes from an OCR bounding box instead of exact glyph metrics.
fn extract_line_segment(
  line: &[&TextElement],
  left: f64,
  right: f64,
  high_precision: bool,
) -> String {
  let mut out = String::new();
  for e in line {
    let chars: Vec<char> = e.text.chars().collect();
    if chars.is_empty() {
      continue;
    }
    if high_precision {
      let weights: Vec<f64> = chars.iter().map(|&c| char_weight(c)).collect();
      let total: f64 = weights.iter().sum();
      if total <= 0.0 {
        continue;
      }
      let unit = e.width / total;
      let mut consumed = 0.0;
      for (k, c) in chars.iter().enumerate() {
        let start = e.x + consumed * unit;
        let center = start + weights[k] * unit * 0.5;
        consumed += weights[k];
        // Use a small epsilon (1e-6) to avoid floating-point boundary exclusion.
        if center >= left - 1e-6 && center < right + 1e-6 {
          out.push(*c);
        }
      }
    } else {
      let advance = e.width / chars.len() as f64;
      for (k, c) in chars.iter().enumerate() {
        let center = e.x + (k as f64 + 0.5) * advance;
        // Use a small epsilon (1e-6) to avoid floating-point boundary exclusion.
        // This is critical for the last column where right == page_width and
        // character centers computed from pdf-inspector positions may fall at
        // the exact boundary due to rounding.
        if center >= left - 1e-6 && center < right + 1e-6 {
          out.push(*c);
        }
      }
    }
  }
  out.trim().to_string()
}

/// Extract table from a page using only vertical lines as column boundaries,
/// and auto-detecting rows from text content.
///
/// This is the primary extraction mode when the user only draws vertical lines.
fn extract_table_from_vertical_lines(
  elements: &[TextElement],
  vertical_lines: &[f64],
  page_width: f64,
  _page_height: f64,
  high_precision: bool,
) -> MdTable {
  let col_bounds = build_col_boundaries(vertical_lines, page_width);
  let ncols = col_bounds.len().saturating_sub(1);

  if ncols == 0 {
    return MdTable {
      columns: Vec::new(),
      rows: Vec::new(),
      page: None,
    };
  }

  // Group text elements into text lines (these become rows)
  let text_lines = group_by_text_lines(elements);
  if text_lines.is_empty() {
    return MdTable {
      columns: Vec::new(),
      rows: Vec::new(),
      page: None,
    };
  }

  // For each text line, cut its characters by the column boundaries.
  let mut data_rows: Vec<Vec<String>> = Vec::new();

  for line in &text_lines {
    let mut row_cells = Vec::with_capacity(ncols);
    for col in 0..ncols {
      row_cells.push(extract_line_segment(
        line,
        col_bounds[col],
        col_bounds[col + 1],
        high_precision,
      ));
    }
    data_rows.push(row_cells);
  }

  // First line is the header
  let columns = data_rows[0].clone();
  let rows = if data_rows.len() > 1 {
    data_rows[1..].to_vec()
  } else {
    Vec::new()
  };

  MdTable {
    columns,
    rows,
    page: None,
  }
}

// ─── Legacy extraction functions (kept for backward compatibility) ────────

/// Build a list of row boundaries from horizontal lines.
/// Returns sorted **descending** y values with implicit top (page_height) and
/// bottom (0) boundaries - PDF's y axis points up, so this enumerates bands
/// from the top of the page downwards.
fn build_row_boundaries(horizontal_lines: &[f64], page_height: f64) -> Vec<f64> {
  let mut boundaries: Vec<f64> = horizontal_lines.to_vec();
  boundaries.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
  boundaries.dedup();
  let mut result = vec![page_height];
  result.extend(boundaries);
  result.push(0.0);
  result
}

/// Extract table from a grid defined by both horizontal and vertical lines.
///
/// Row bands come from the drawn horizontal lines (topmost band is the
/// header). Every element is assigned to exactly ONE band by its **vertical
/// center** - not by rectangle overlap - so an element whose box straddles a
/// band boundary can never leak into a neighbouring row (this mirrors the
/// image-table grid path in `snip.rs`). Inside a band, elements are grouped
/// into visual text lines, each line is cut into columns with the precise
/// per-character cutter, and the per-column cells merge so the GFM row count
/// matches the band count even when a cell wraps over several lines.
fn extract_table_from_grid(
  elements: &[TextElement],
  horizontal_lines: &[f64],
  vertical_lines: &[f64],
  page_width: f64,
  page_height: f64,
  high_precision: bool,
) -> MdTable {
  let row_bounds = build_row_boundaries(horizontal_lines, page_height);
  let col_bounds = build_col_boundaries(vertical_lines, page_width);

  let nrows = row_bounds.len().saturating_sub(1);
  let ncols = col_bounds.len().saturating_sub(1);

  if nrows == 0 || ncols == 0 {
    return MdTable {
      columns: Vec::new(),
      rows: Vec::new(),
      page: None,
    };
  }

  // Bucket every element into exactly one band by its vertical center.
  // Band i is [row_bounds[i+1], row_bounds[i]) since bounds are descending.
  let mut banded: Vec<Vec<&TextElement>> = vec![Vec::new(); nrows];
  for e in elements {
    let center = e.y + e.font_size / 2.0;
    for (i, pair) in row_bounds.windows(2).enumerate() {
      if center >= pair[1] && center < pair[0] {
        banded[i].push(e);
        break;
      }
    }
  }

  // Build one GFM row per band.
  let mut row_outputs: Vec<Vec<String>> = Vec::with_capacity(nrows);
  for band in &banded {
    if band.is_empty() {
      row_outputs.push(vec![String::new(); ncols]);
      continue;
    }
    let mut merged: Vec<Vec<String>> = vec![Vec::new(); ncols];
    for line in group_text_line_refs(band) {
      for (col, cell) in (0..ncols)
        .map(|col| {
          extract_line_segment(&line, col_bounds[col], col_bounds[col + 1], high_precision)
        })
        .enumerate()
      {
        if !cell.is_empty() {
          merged[col].push(cell);
        }
      }
    }
    row_outputs.push(merged.into_iter().map(|parts| parts.join(" ")).collect());
  }

  // Topmost band is the header, the rest are data rows.
  let columns = row_outputs[0].clone();
  let rows = if row_outputs.len() > 1 {
    row_outputs[1..].to_vec()
  } else {
    Vec::new()
  };

  MdTable {
    columns,
    rows,
    page: None,
  }
}

/// Group a set of text elements (by reference) into visual text lines, top to
/// bottom, x ascending within a line - the reference-flavoured sibling of
/// [`group_by_text_lines`] used for band-local grouping.
fn group_text_line_refs<'a>(items: &[&'a TextElement]) -> Vec<Vec<&'a TextElement>> {
  if items.is_empty() {
    return Vec::new();
  }
  let mut sorted: Vec<&TextElement> = items.to_vec();
  sorted.sort_by(|a, b| {
    b.y
      .partial_cmp(&a.y)
      .unwrap_or(std::cmp::Ordering::Equal)
      .then_with(|| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
  });

  let mut lines: Vec<Vec<&TextElement>> = Vec::new();
  let mut cur = vec![sorted[0]];
  let mut cur_y = sorted[0].y;
  for e in &sorted[1..] {
    let threshold = (e.font_size * 0.4).max(3.0);
    if (e.y - cur_y).abs() < threshold {
      cur.push(*e);
    } else {
      cur.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
      lines.push(std::mem::take(&mut cur));
      cur.push(*e);
      cur_y = e.y;
    }
  }
  cur.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
  lines.push(cur);
  lines
}

/// Extract table from a rectangular region by auto-detecting row/column structure.
fn extract_table_from_rectangle(elements: &[TextElement], rect: &DrawTableRegion) -> MdTable {
  let filtered = filter_text_by_region(elements, rect);
  if filtered.is_empty() {
    return MdTable {
      columns: Vec::new(),
      rows: Vec::new(),
      page: None,
    };
  }

  // Group into text lines
  let lines = group_by_text_lines(&filtered);
  if lines.is_empty() {
    return MdTable {
      columns: Vec::new(),
      rows: Vec::new(),
      page: None,
    };
  }

  // Auto-detect column boundaries by analyzing x-coordinate positions
  // across all lines to find consistent column separators
  let mut all_x_positions: Vec<f64> = Vec::new();
  for line in &lines {
    for elem in line {
      all_x_positions.push(elem.x);
    }
  }

  if all_x_positions.is_empty() {
    // Single column: each line is a cell
    let columns = vec!["Column 1".to_string()];
    let rows: Vec<Vec<String>> = lines
      .iter()
      .map(|line| {
        vec![
          line
            .iter()
            .map(|e| e.text.trim())
            .collect::<Vec<&str>>()
            .join(" "),
        ]
      })
      .collect();
    // First line is header
    let mut result = MdTable {
      columns: if !rows.is_empty() {
        rows[0].clone()
      } else {
        columns
      },
      rows: if rows.len() > 1 {
        rows[1..].to_vec()
      } else {
        Vec::new()
      },
      page: None,
    };
    // If only one row, treat it as a single-row table
    if result.columns.is_empty() {
      result.columns = vec!["Content".to_string()];
    }
    return result;
  }

  // Simple column detection: cluster x positions across all lines
  let first_line = &lines[0];
  // Use the first line's element count as a hint for column count
  let col_count_hint = first_line.len();

  if col_count_hint <= 1 {
    // Single column output
    let columns = vec!["Content".to_string()];
    let rows: Vec<Vec<String>> = lines
      .iter()
      .map(|line| {
        vec![
          line
            .iter()
            .map(|e| e.text.trim())
            .collect::<Vec<&str>>()
            .join(" "),
        ]
      })
      .collect();
    let mut result = MdTable {
      columns: if !rows.is_empty() {
        rows[0].clone()
      } else {
        columns
      },
      rows: if rows.len() > 1 {
        rows[1..].to_vec()
      } else {
        Vec::new()
      },
      page: None,
    };
    if result.columns.is_empty() {
      result.columns = vec!["Content".to_string()];
    }
    return result;
  }

  // Multi-column: treat each element in a line as a separate cell
  // For the header, use the first line
  let mut columns = Vec::new();
  let mut data_rows = Vec::new();

  for (idx, line) in lines.iter().enumerate() {
    let row_cells: Vec<String> = line.iter().map(|e| e.text.trim().to_string()).collect();
    if idx == 0 {
      columns = row_cells;
    } else {
      // Pad or trim to match column count
      let mut padded = row_cells;
      while padded.len() < col_count_hint {
        padded.push(String::new());
      }
      if padded.len() > col_count_hint {
        padded.truncate(col_count_hint);
      }
      data_rows.push(padded);
    }
  }

  if columns.is_empty() {
    columns = (0..col_count_hint)
      .map(|i| format!("Column {}", i + 1))
      .collect();
  }

  MdTable {
    columns,
    rows: data_rows,
    page: None,
  }
}

/// Main function: extract tables from a PDF based on user-drawn lines.
///
/// `use_cache` enables the full-document extraction cache (see
/// [`extract_cache`]): when on, the first full extraction decodes the whole
/// document and later calls reuse it; when off, only the pages in the request
/// are decoded each time.
///
/// `high_precision` selects the width-weighted character cutting for OCR
/// blocks (see [`extract_line_segment`]); it mirrors the frontend setting that
/// also renders OCR page images at a higher DPI.
pub fn extract_tables_from_draw_lines(
  path: &str,
  request: &DrawTableRequest,
  use_cache: bool,
  high_precision: bool,
  ocr_engines: Option<&DrawOcrEngines>,
  text_separator: &str,
) -> Result<DrawTableResult, String> {
  let start = Instant::now();

  // When the user asks for the drawn lines to apply to the whole document,
  // reuse the first entry that actually carries lines for every page.
  let use_for_all_pages = request.use_for_all_pages.unwrap_or(false);
  let max_pages = request.max_pages.filter(|&n| n > 0);

  let template = request.pages.iter().find(|p| {
    !p.vertical_lines.is_empty()
      || !p.horizontal_lines.is_empty()
      || p.rectangles.as_ref().is_some_and(|r| !r.is_empty())
  });

  if use_for_all_pages && template.is_none() {
    return Ok(DrawTableResult {
      table_count: 0,
      tables: Vec::new(),
      regions: Vec::new(),
      processing_time_ms: start.elapsed().as_millis() as u64,
      total_rows: 0,
      ocr_pages: Vec::new(),
      empty_text_pages: Vec::new(),
      ocr_confidence: None,
    });
  }

  // Only decode text for the pages we will actually process. The full-document
  // font/CMap + content-stream decode dominates extraction time, so this makes
  // the "first 5 pages" preview (and per-page line drawing) avoid paying for
  // pages that are never inspected.
  let page_filter: Option<HashSet<u32>> = if use_for_all_pages {
    // Lines apply to pages 1..=end; when limited to a preview range we know the
    // exact pages up front (extra numbers beyond the document are no-ops).
    max_pages.map(|n| (1..=n).collect())
  } else {
    // Per-page mode: only the pages that actually carry lines matter.
    Some(
      request
        .pages
        .iter()
        .filter(|p| {
          !p.vertical_lines.is_empty()
            || !p.horizontal_lines.is_empty()
            || p.rectangles.as_ref().is_some_and(|r| !r.is_empty())
        })
        .map(|p| p.page)
        .collect(),
    )
  };

  let is_preview = use_for_all_pages && max_pages.is_some();
  // Extract positioned text once; pdf-inspector decodes each font via its
  // `/ToUnicode` CMap so CJK content is not garbled (raw byte decoding would
  // produce mojibake for Chinese tables). Only a full-document extraction uses
  // the cache: previews (first-N pages) decode just what they show and never
  // populate it, so the whole document isn't parsed just to preview.
  let items = if !use_cache {
    extract_text_elements(path, page_filter.as_ref())?
  } else if is_preview {
    // Reuse the full-document cache when present (instant), otherwise decode
    // only the previewed pages and leave the cache untouched.
    match extract_cache::peek_items(path) {
      Some(items) => items,
      None => extract_text_elements(path, page_filter.as_ref())?,
    }
  } else {
    extract_cache::cached_extraction(path, true, text_separator)
      .map(|ext| ext.items)
      .map_err(|e| e.to_string())?
  };

  let effective_pages: Vec<PageDrawTable> =
    if let Some(template) = template.filter(|_| use_for_all_pages) {
      // Without a page limit the lines apply to every page, bounded by the last
      // page that actually has text items - or by the page count reported by
      // the frontend, since scanned documents have no text items at all.
      let total_pages = items
        .iter()
        .map(|it| it.page)
        .max()
        .unwrap_or(0)
        .max(request.total_pages.unwrap_or(0));
      let end_page = max_pages.unwrap_or(total_pages);
      (1..=end_page)
        .map(|page| {
          let mut entry = template.clone();
          entry.page = page;
          entry
        })
        .collect()
    } else {
      request.pages.clone()
    };

  // Batched OCR extractions restrict processing to the pages carried by the
  // current batch's images; everything else was handled in an earlier batch.
  let effective_pages: Vec<PageDrawTable> = match &request.only_pages {
    Some(only) => {
      let set: HashSet<u32> = only.iter().copied().collect();
      effective_pages
        .into_iter()
        .filter(|p| set.contains(&p.page))
        .collect()
    }
    None => effective_pages,
  };

  // Rendered page images for the local OCR fallback, keyed by page number.
  let page_images: HashMap<u32, &PageImagePayload> = request
    .page_images
    .iter()
    .flatten()
    .map(|img| (img.page, img))
    .collect();

  let mut tables = Vec::new();
  let mut regions = Vec::new();
  let mut ocr_pages = Vec::new();
  let mut empty_text_pages = Vec::new();
  let mut ocr_confidence_sum = 0.0f64;
  let mut ocr_confidence_count = 0u32;

  for page_draw in &effective_pages {
    let page_num = page_draw.page;
    // Use the page dimensions and origin from the frontend (pdfjs rawDims),
    // which account for the CropBox and correct coordinate system.
    // This avoids the MediaBox vs CropBox mismatch and userUnit scaling issues.
    let origin_x = page_draw.page_x;
    let origin_y = page_draw.page_y;
    let page_width = page_draw.page_width;
    let page_height = page_draw.page_height;
    // The frontend (pdfjs viewport) puts the viewBox's lower-left corner at
    // (0,0), so shift pdf-inspector's absolute user-space coordinates by the
    // viewBox origin to make both sides agree.
    let mut elements: Vec<TextElement> = to_text_elements(&items, page_num)
      .into_iter()
      .map(|mut e| {
        e.x -= origin_x;
        e.y -= origin_y;
        e
      })
      .collect();

    // Scanned / image-only pages have no text layer at all. When the frontend
    // supplied a rendered PNG for this page, run the mode-selected OCR
    // fallback: local PaddleOCR yields positioned text blocks that feed the
    // same column-cutting pipeline, remote AI vision answers with a GFM table
    // cut by the drawn separator positions.
    let mut ai_yielded = false;
    if elements.is_empty() {
      if let Some(img) = page_images.get(&page_num) {
        if let Some(engines) = ocr_engines {
          if let Some(engine) = engines.local {
            if let Ok((ocr_elements, confidence)) = ocr_text_elements(engine, img) {
              if !ocr_elements.is_empty() {
                elements = ocr_elements;
                ocr_pages.push(page_num);
                ocr_confidence_sum += confidence as f64;
                ocr_confidence_count += 1;
              }
            }
          }
          // Remote AI vision: parse the model's markdown answer directly.
          if elements.is_empty() {
            if let Some(provider) = engines.remote {
              match ai_tables_for_page(provider, engines.remote_prompt, img, page_draw) {
                Ok(ai_tables) => {
                  for table in ai_tables {
                    tables.push(table);
                    regions.push(TableRegionInfo {
                      page: page_num,
                      row_start: 0.0,
                      row_end: page_height,
                      col_start: 0.0,
                      col_end: page_width,
                    });
                  }
                  ocr_pages.push(page_num);
                  ai_yielded = true;
                }
                Err(_) => {
                  // Provider failure degrades to an empty result for this
                  // page, consistent with the local fallback behavior.
                }
              }
            }
          }
        }
      }
    }
    if elements.is_empty() && !ai_yielded {
      empty_text_pages.push(page_num);
    }

    // Exclusion regions: drop the content the user masked out. Applied after
    // the empty-page check above on purpose - deciding OCR routing from
    // filtered elements would make a page that exclusions emptied look like a
    // scanned page, exactly the trap the conversion pipeline avoids (see
    // docs/design/00010_pdf-exclude-region.md §4.1).
    if let Some(spec) = &request.exclusions {
      let rects = region_exclude::rects_for_page(spec, page_num);
      if !rects.is_empty() {
        elements = filter_elements(&rects, elements);
      }
    }

    // Process rectangle-based tables (legacy)
    if let Some(rects) = &page_draw.rectangles {
      for rect in rects {
        let region = DrawTableRegion {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
        let table = extract_table_from_rectangle(&elements, &region);
        if !table.columns.is_empty() {
          tables.push(table);
          regions.push(TableRegionInfo {
            page: page_num,
            row_start: rect.y,
            row_end: rect.y + rect.height,
            col_start: rect.x,
            col_end: rect.x + rect.width,
          });
        }
      }
    }

    // Process grid-based tables (horizontal + vertical lines)
    // or vertical-lines-only tables (auto-detect rows)
    if !page_draw.vertical_lines.is_empty() {
      if page_draw.horizontal_lines.is_empty() {
        // Vertical lines only: auto-detect rows from text content
        let table = extract_table_from_vertical_lines(
          &elements,
          &page_draw.vertical_lines,
          page_width,
          page_height,
          high_precision,
        );
        if !table.columns.is_empty() {
          tables.push(table);
          regions.push(TableRegionInfo {
            page: page_num,
            row_start: 0.0,
            row_end: page_height,
            col_start: 0.0,
            col_end: page_width,
          });
        }
      } else {
        // Both horizontal and vertical lines: use grid mode
        let table = extract_table_from_grid(
          &elements,
          &page_draw.horizontal_lines,
          &page_draw.vertical_lines,
          page_width,
          page_height,
          high_precision,
        );
        if !table.columns.is_empty() {
          tables.push(table);
          regions.push(TableRegionInfo {
            page: page_num,
            row_start: 0.0,
            row_end: page_height,
            col_start: 0.0,
            col_end: page_width,
          });
        }
      }
    }
  }

  let table_count = tables.len();
  let total_rows: usize = tables.iter().map(|t| t.rows.len()).sum();

  Ok(DrawTableResult {
    table_count,
    tables,
    regions,
    processing_time_ms: start.elapsed().as_millis() as u64,
    total_rows,
    ocr_pages,
    empty_text_pages,
    ocr_confidence: (ocr_confidence_count > 0)
      .then(|| (ocr_confidence_sum / ocr_confidence_count as f64) as f32),
  })
}

/// Extract tables and merge them into an existing Markdown document.
pub fn extract_tables_and_merge(
  path: &str,
  request: &DrawTableRequest,
  existing_markdown: Option<&str>,
  use_cache: bool,
  high_precision: bool,
  ocr_engines: Option<&DrawOcrEngines>,
  text_separator: &str,
) -> Result<String, String> {
  let result = extract_tables_from_draw_lines(
    path,
    request,
    use_cache,
    high_precision,
    ocr_engines,
    text_separator,
  )?;

  if result.tables.is_empty() {
    return if let Some(md) = existing_markdown {
      Ok(md.to_string())
    } else {
      Ok(String::new())
    };
  }

  // Build the table markdown section. Each table was recorded alongside a
  // region carrying its source page, so we emit a `<!-- Page N -->` marker
  // before each new page's tables. The frontend Markdown preview paginates on
  // these markers, so extracting a large document never renders every table at
  // once on the UI thread.
  let mut table_md = String::new();
  let mut current_page: Option<u32> = None;

  for (idx, (table, region)) in result.tables.iter().zip(result.regions.iter()).enumerate() {
    if idx > 0 {
      table_md.push_str("\n\n---\n\n");
    }

    if current_page != Some(region.page) {
      current_page = Some(region.page);
      table_md.push_str(&page_marker(region.page));
      table_md.push_str("\n\n");
    }

    // Build GFM table
    // Header row
    table_md.push('|');
    for col in &table.columns {
      table_md.push(' ');
      table_md.push_str(col);
      table_md.push_str(" |");
    }
    table_md.push('\n');

    // Delimiter row
    table_md.push('|');
    for _ in &table.columns {
      table_md.push_str(" --- |");
    }
    table_md.push('\n');

    // Data rows
    for row in &table.rows {
      table_md.push('|');
      for cell in row {
        table_md.push(' ');
        table_md.push_str(cell);
        table_md.push_str(" |");
      }
      table_md.push('\n');
    }
  }

  // Merge with existing markdown
  match existing_markdown {
    Some(md) if !md.trim().is_empty() => {
      let mut merged = md.trim().to_string();
      merged.push_str("\n\n---\n\n<!-- Draw lines to extract tables -->\n\n");
      merged.push_str(&table_md);
      Ok(merged)
    }
    _ => Ok(table_md),
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_filter_text_by_region() {
    let elements = vec![
      TextElement {
        text: "A".to_string(),
        x: 10.0,
        y: 100.0,
        width: 10.0,
        font_size: 12.0,
      },
      TextElement {
        text: "B".to_string(),
        x: 50.0,
        y: 50.0,
        width: 10.0,
        font_size: 12.0,
      },
      TextElement {
        text: "C".to_string(),
        x: 200.0,
        y: 200.0,
        width: 10.0,
        font_size: 12.0,
      },
    ];

    let region = DrawTableRegion {
      x: 0.0,
      y: 0.0,
      width: 100.0,
      height: 150.0,
    };
    let filtered = filter_text_by_region(&elements, &region);
    assert_eq!(filtered.len(), 2);
    assert_eq!(filtered[0].text, "A");
    assert_eq!(filtered[1].text, "B");
  }

  // ── Exclusion regions (docs/design/00011) ────────────────────────────────

  fn el(text: &str, x: f64, y: f64) -> TextElement {
    TextElement {
      text: text.to_string(),
      x,
      y,
      width: text.chars().count() as f64 * 6.0,
      font_size: 12.0,
    }
  }

  /// A page header plus a two-row table, cut into three columns by vertical
  /// lines at x=200 and x=330.
  fn page_elements() -> Vec<TextElement> {
    vec![
      el("CONFIDENTIAL", 72.0, 800.0),
      el("Name", 80.0, 730.0),
      el("Age", 250.0, 730.0),
      el("City", 380.0, 730.0),
      el("Alice", 80.0, 700.0),
      el("28", 250.0, 700.0),
      el("Beijing", 380.0, 700.0),
    ]
  }

  fn cut_into_columns(elements: Vec<TextElement>) -> MdTable {
    extract_table_from_vertical_lines(&elements, &[200.0, 330.0], 595.0, 842.0, false)
  }

  fn band(x: f64, y: f64, width: f64, height: f64) -> Vec<RegionRect> {
    vec![RegionRect {
      x,
      y,
      width,
      height,
    }]
  }

  #[test]
  fn no_exclusions_keeps_the_whole_page() {
    let base = cut_into_columns(page_elements());
    // The page header is simply the topmost text line, so it becomes the
    // table header when nothing is excluded.
    assert_eq!(base.columns, vec!["CONFIDENTIAL", "", ""]);
    assert_eq!(base.rows[0], vec!["Name", "Age", "City"]);
    assert_eq!(base.rows[1], vec!["Alice", "28", "Beijing"]);
  }

  #[test]
  fn a_header_band_removes_the_page_header() {
    let filtered = filter_elements(&band(0.0, 780.0, 595.0, 62.0), page_elements());
    let table = cut_into_columns(filtered);
    // The excluded line is gone, so the real column row becomes the header.
    assert_eq!(table.columns, vec!["Name", "Age", "City"]);
    assert_eq!(table.rows, vec![vec!["Alice", "28", "Beijing"]]);
  }

  #[test]
  fn a_column_band_removes_only_that_column() {
    // Band over the "Age" column (x 240..270) at full height.
    let filtered = filter_elements(&band(240.0, 0.0, 30.0, 842.0), page_elements());
    let table = cut_into_columns(filtered);
    assert_eq!(table.columns, vec!["CONFIDENTIAL", "", ""]);
    assert_eq!(table.rows[0], vec!["Name", "", "City"]);
    assert_eq!(
      table.rows[1],
      vec!["Alice", "", "Beijing"],
      "the right-hand column must keep its own slot instead of shifting left"
    );
  }

  /// pdf-inspector merges a visual line into a single element, so a band over
  /// one column must not erase the whole row - and the surviving pieces must
  /// still land in the columns their x belongs to.
  #[test]
  fn a_column_band_splits_a_merged_row_into_its_original_columns() {
    let merged = vec![TextElement {
      text: "Alice   28   Beijing".to_string(),
      x: 80.0,
      y: 700.0,
      width: 400.0,
      font_size: 12.0,
    }];
    // Covers the "28" token (x 240..280) plus the padding around it.
    let filtered = filter_elements(&band(235.0, 0.0, 50.0, 842.0), merged);
    assert_eq!(
      filtered.len(),
      2,
      "expected both sides to survive: {filtered:?}"
    );
    let table = cut_into_columns(filtered);
    assert_eq!(
      table.columns,
      vec!["Alice", "", "Beijing"],
      "each piece must be cut into the column its x belongs to"
    );
  }

  #[test]
  fn test_build_col_boundaries() {
    let lines = vec![200.0, 400.0];
    let bounds = build_col_boundaries(&lines, 612.0);
    assert_eq!(bounds, vec![0.0, 200.0, 400.0, 612.0]);
  }

  #[test]
  fn test_build_boundaries_empty() {
    let bounds = build_col_boundaries(&[], 612.0);
    assert_eq!(bounds, vec![0.0, 612.0]);
  }

  #[test]
  fn test_build_boundaries_dedup() {
    let bounds = build_col_boundaries(&[200.0, 200.0, 400.0], 612.0);
    assert_eq!(bounds, vec![0.0, 200.0, 400.0, 612.0]);
  }

  #[test]
  fn test_group_by_text_lines() {
    let elements = vec![
      TextElement {
        text: "A".to_string(),
        x: 10.0,
        y: 100.0,
        width: 10.0,
        font_size: 12.0,
      },
      TextElement {
        text: "B".to_string(),
        x: 50.0,
        y: 100.0,
        width: 10.0,
        font_size: 12.0,
      },
      TextElement {
        text: "C".to_string(),
        x: 10.0,
        y: 50.0,
        width: 10.0,
        font_size: 12.0,
      },
    ];

    let lines = group_by_text_lines(&elements);
    // Elements at y=100 and y=50 should be in different lines
    // But due to font_size threshold (12 * 1.2 = 14.4), they might be grouped
    assert_eq!(lines.len(), 2, "should have 2 text lines");
    // First line should have elements at y=100 (higher y = top in PDF)
    assert_eq!(lines[0].len(), 2);
    assert_eq!(lines[0][0].text, "A");
    assert_eq!(lines[0][1].text, "B");
    // Second line at y=50
    assert_eq!(lines[1].len(), 1);
    assert_eq!(lines[1][0].text, "C");
  }

  #[test]
  fn test_extract_table_from_vertical_lines_merged_rows() {
    // Header cells are separate items (e.g. bold, so pdf-inspector won't merge
    // them), while data rows arrive as ONE merged item per row (dense layout).
    let elements = vec![
      // Header row
      TextElement {
        text: "姓名".to_string(),
        x: 10.0,
        y: 100.0,
        width: 24.0,
        font_size: 12.0,
      },
      TextElement {
        text: "年龄".to_string(),
        x: 46.0,
        y: 100.0,
        width: 24.0,
        font_size: 12.0,
      },
      TextElement {
        text: "城市".to_string(),
        x: 82.0,
        y: 100.0,
        width: 24.0,
        font_size: 12.0,
      },
      // Merged data rows: one item spanning the whole row
      TextElement {
        text: "张三 28 北京".to_string(),
        x: 10.0,
        y: 70.0,
        width: 96.0,
        font_size: 12.0,
      },
      TextElement {
        text: "李四 35 上海".to_string(),
        x: 10.0,
        y: 40.0,
        width: 96.0,
        font_size: 12.0,
      },
    ];

    let table = extract_table_from_vertical_lines(&elements, &[40.0, 76.0], 120.0, 150.0, false);
    assert_eq!(table.columns, vec!["姓名", "年龄", "城市"]);
    assert_eq!(table.rows.len(), 2);
    assert_eq!(table.rows[0], vec!["张三", "28", "北京"]);
    assert_eq!(table.rows[1], vec!["李四", "35", "上海"]);
  }

  #[test]
  fn test_extract_table_from_vertical_lines_simple() {
    let elements = vec![
      // Header row
      TextElement {
        text: "姓名".to_string(),
        x: 10.0,
        y: 100.0,
        width: 24.0,
        font_size: 12.0,
      },
      TextElement {
        text: "年龄".to_string(),
        x: 100.0,
        y: 100.0,
        width: 24.0,
        font_size: 12.0,
      },
      TextElement {
        text: "城市".to_string(),
        x: 200.0,
        y: 100.0,
        width: 24.0,
        font_size: 12.0,
      },
      // Data row 1
      TextElement {
        text: "张三".to_string(),
        x: 10.0,
        y: 70.0,
        width: 24.0,
        font_size: 12.0,
      },
      TextElement {
        text: "28".to_string(),
        x: 100.0,
        y: 70.0,
        width: 16.0,
        font_size: 12.0,
      },
      TextElement {
        text: "北京".to_string(),
        x: 200.0,
        y: 70.0,
        width: 24.0,
        font_size: 12.0,
      },
      // Data row 2
      TextElement {
        text: "李四".to_string(),
        x: 10.0,
        y: 40.0,
        width: 24.0,
        font_size: 12.0,
      },
      TextElement {
        text: "35".to_string(),
        x: 100.0,
        y: 40.0,
        width: 16.0,
        font_size: 12.0,
      },
      TextElement {
        text: "上海".to_string(),
        x: 200.0,
        y: 40.0,
        width: 24.0,
        font_size: 12.0,
      },
    ];

    // Vertical lines at x=80 (between 姓名 and 年龄), x=180 (between 年龄 and 城市)
    let table = extract_table_from_vertical_lines(&elements, &[80.0, 180.0], 300.0, 150.0, false);
    assert_eq!(table.columns.len(), 3);
    assert_eq!(table.columns[0], "姓名");
    assert_eq!(table.columns[1], "年龄");
    assert_eq!(table.columns[2], "城市");
    assert_eq!(table.rows.len(), 2);
    assert_eq!(table.rows[0][0], "张三");
    assert_eq!(table.rows[0][1], "28");
    assert_eq!(table.rows[0][2], "北京");
    assert_eq!(table.rows[1][0], "李四");
    assert_eq!(table.rows[1][1], "35");
    assert_eq!(table.rows[1][2], "上海");
  }

  #[test]
  fn test_ocr_blocks_to_elements_maps_pixel_space_to_pdf_points() {
    let recognition = OcrRecognition {
      blocks: vec![
        crate::core::ocr::OcrBlock {
          text: "姓名".to_string(),
          left: 20.0,
          top: 40.0,
          width: 50.0,
          height: 25.0,
        },
        crate::core::ocr::OcrBlock {
          text: "28".to_string(),
          left: 200.0,
          top: 100.0,
          width: 30.0,
          height: 20.0,
        },
      ],
      height_px: 500,
      confidence: 0.9,
    };
    let elements = ocr_blocks_to_elements(&recognition, 2.5);
    assert_eq!(elements.len(), 2);

    // x scales by 1/render_scale.
    assert_eq!(elements[0].x, 8.0);
    assert_eq!(elements[0].width, 20.0);
    // y flips from top-left pixel origin to bottom-left point origin.
    // Block 0: bottom edge at px 65 > (500 - 65) / 2.5 = 174.
    assert_eq!(elements[0].y, 174.0);
    assert_eq!(elements[0].font_size, 10.0);
    // Block 1: bottom edge at px 120 > (500 - 120) / 2.5 = 152.
    assert_eq!(elements[1].y, 152.0);
  }

  #[test]
  fn test_ocr_elements_feed_vertical_line_extraction() {
    // A scanned-page table recognized by OCR: two rows of blocks that must be
    // cut into columns exactly like pdf-inspector text items would be.
    let recognition = OcrRecognition {
      blocks: vec![
        crate::core::ocr::OcrBlock {
          text: "姓名".to_string(),
          left: 25.0,
          top: 250.0,
          width: 60.0,
          height: 25.0,
        },
        crate::core::ocr::OcrBlock {
          text: "年龄".to_string(),
          left: 225.0,
          top: 250.0,
          width: 60.0,
          height: 25.0,
        },
        crate::core::ocr::OcrBlock {
          text: "张三".to_string(),
          left: 25.0,
          top: 375.0,
          width: 60.0,
          height: 25.0,
        },
        crate::core::ocr::OcrBlock {
          text: "28".to_string(),
          left: 240.0,
          top: 375.0,
          width: 30.0,
          height: 25.0,
        },
      ],
      height_px: 750,
      confidence: 0.85,
    };

    let elements = ocr_blocks_to_elements(&recognition, 2.5);
    let table = extract_table_from_vertical_lines(&elements, &[80.0, 180.0], 300.0, 300.0, true);
    assert_eq!(table.columns.len(), 3);
    assert_eq!(table.columns[0], "姓名");
    assert_eq!(table.columns[1], "年龄");
    assert_eq!(table.rows.len(), 1);
    assert_eq!(table.rows[0][0], "张三");
    assert_eq!(table.rows[0][1], "28");
  }

  #[test]
  fn test_high_precision_weighted_cutting_handles_mixed_width_rows() {
    // One OCR block spanning a whole row: two CJK cells + one numeric cell.
    // Uniform advance misplaces the digit centers; width weighting fixes it.
    let elements = vec![TextElement {
      text: "姓名 128 年龄".to_string(),
      x: 20.0,
      y: 100.0,
      // Real layout: 姓名(2 CJK = 4 units) + space + 128 (3 digits) +
      // space + 年龄 (4 units) => 13 half-width units over 130pt.
      width: 130.0,
      font_size: 12.0,
    }];

    // Column boundary between the digits (weighted center 95) and the
    // trailing cell (weighted centers >= 105). The single text line becomes
    // the table's header row.
    let table = extract_table_from_vertical_lines(&elements, &[97.0], 200.0, 150.0, true);
    assert_eq!(table.columns[0], "姓名 128");
    assert_eq!(table.columns[1], "年龄");

    // The uniform-advance estimate drifts the same row across the boundary
    // (documents the regression the weighted mode fixes).
    let uniform = extract_table_from_vertical_lines(&elements, &[97.0], 200.0, 150.0, false);
    assert_ne!(
      (uniform.columns[0].as_str(), uniform.columns[1].as_str()),
      ("姓名 128", "年龄"),
      "uniform advance should mis-cut this mixed-width row"
    );
  }

  #[test]
  fn test_extract_table_from_grid_top_band_is_header() {
    // Elements laid out on a page of height 150: header text near the top
    // (y=120), data rows below (y=70, y=40). One horizontal boundary at y=100.
    let elements = vec![
      TextElement {
        text: "姓名".to_string(),
        x: 10.0,
        y: 120.0,
        width: 24.0,
        font_size: 12.0,
      },
      TextElement {
        text: "年龄".to_string(),
        x: 60.0,
        y: 120.0,
        width: 24.0,
        font_size: 12.0,
      },
      TextElement {
        text: "张三".to_string(),
        x: 10.0,
        y: 70.0,
        width: 24.0,
        font_size: 12.0,
      },
      TextElement {
        text: "28".to_string(),
        x: 60.0,
        y: 70.0,
        width: 16.0,
        font_size: 12.0,
      },
    ];

    // Column boundary between the two columns; row boundary at y=100 splits
    // the header band from the data band.
    let table = extract_table_from_grid(&elements, &[100.0], &[45.0], 100.0, 150.0, false);
    assert_eq!(table.columns, vec!["姓名", "年龄"]);
    assert_eq!(table.rows.len(), 1);
    assert_eq!(table.rows[0], vec!["张三", "28"]);
  }

  #[test]
  fn test_extract_table_from_grid_center_bucket_prevents_band_leak() {
    // The third element's rectangle (y=96..110) overlaps BOTH bands around
    // the y=100 boundary, but its center (103) lies in the header band - so
    // it must appear ONLY in the header, never duplicated in the data row.
    let elements = vec![
      TextElement {
        text: "表头".to_string(),
        x: 10.0,
        y: 120.0,
        width: 24.0,
        font_size: 12.0,
      },
      TextElement {
        text: "H2".to_string(),
        x: 60.0,
        y: 120.0,
        width: 16.0,
        font_size: 12.0,
      },
      TextElement {
        text: "跨带".to_string(),
        x: 10.0,
        y: 96.0,
        width: 24.0,
        font_size: 14.0, // center 103 -> header band
      },
      TextElement {
        text: "数据".to_string(),
        x: 10.0,
        y: 60.0,
        width: 24.0,
        font_size: 12.0, // center 66 -> data band
      },
      TextElement {
        text: "D2".to_string(),
        x: 60.0,
        y: 60.0,
        width: 16.0,
        font_size: 12.0,
      },
    ];

    let table = extract_table_from_grid(&elements, &[100.0], &[45.0], 100.0, 150.0, false);
    // Header merges the two stacked lines of its band; the leaking element
    // never reaches the data row.
    assert_eq!(table.columns, vec!["表头 跨带", "H2"]);
    assert_eq!(table.rows.len(), 1);
    assert_eq!(table.rows[0], vec!["数据", "D2"]);
  }

  #[test]
  fn test_line_percentages() {
    // 750px image at scale 2.5 > 300pt wide; points map linearly to percent.
    let pcts = line_percentages(&[75.0, 150.0, 400.0], 2.5, 750);
    assert_eq!(pcts, vec![25.0, 50.0, 100.0]);
    // Degenerate inputs yield no positions.
    assert!(line_percentages(&[10.0], 2.5, 0).is_empty());
    assert!(line_percentages(&[10.0], 0.0, 750).is_empty());
  }
}
