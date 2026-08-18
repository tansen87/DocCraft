use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Instant;

use pdf_inspector::TextItem;
use pdf_inspector::extractor::ItemType;

use crate::core::page_marker::page_marker;
use crate::models::{
  DrawTableRegion, DrawTableRequest, DrawTableResult, MdTable, PageDrawTable, TableRegionInfo,
};

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
/// pages is not decoded). This is the main cost of a line-draw extraction —
/// font CMap + content-stream decoding scales with the number of pages decoded,
/// so skipping pages we do not process keeps previews and single-page work fast.
fn extract_text_elements(
  path: &str,
  page_filter: Option<&HashSet<u32>>,
) -> Result<Vec<TextItem>, String> {
  pdf_inspector::extract_text_with_positions_pages(path, page_filter)
    .map_err(|e| format!("Text extraction failed: {e}"))
}

/// Full-document text cache: a single slot holds the decoded items for the
/// currently open PDF. Extracted text does not depend on the drawn lines, so
/// full-document extractions decode the whole document once and reuse it on
/// every subsequent draw/merge — the dominant cost (font `/ToUnicode` CMap +
/// content-stream decoding) is paid a single time per document instead of on
/// every extraction. Switching files evicts the old document. The "first-N
/// pages" preview never populates this cache (it decodes only the previewed
/// pages), so it stays empty until a real full extraction happens.
struct PageCache {
  path: String,
  items: Vec<TextItem>,
}

static TEXT_ITEM_CACHE: Mutex<Option<PageCache>> = Mutex::new(None);

/// Return the full-document text items for `path`, populating the single-slot
/// cache on the first call and cloning it on later calls.
fn cached_text_elements(path: &str) -> Result<Vec<TextItem>, String> {
  let mut guard = TEXT_ITEM_CACHE.lock().unwrap();
  if let Some(cache) = guard.as_ref() {
    if cache.path == path {
      return Ok(cache.items.clone());
    }
  }
  let items = extract_text_elements(path, None)?;
  *guard = Some(PageCache {
    path: path.to_string(),
    items: items.clone(),
  });
  Ok(items)
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

/// Extract the text content from a single cell region.
fn extract_cell_text(elements: &[TextElement], region: &DrawTableRegion) -> String {
  let filtered = filter_text_by_region(elements, region);
  if filtered.is_empty() {
    return String::new();
  }

  let lines = group_by_text_lines(&filtered);
  let cell_texts: Vec<String> = lines
    .iter()
    .map(|line| {
      line
        .iter()
        .map(|e| e.text.trim())
        .collect::<Vec<&str>>()
        .join(" ")
    })
    .collect();

  cell_texts.join("\n")
}

/// Extract the portion of a text line that falls inside the column `[left, right)`.
///
/// pdf-inspector merges same-style items on a line into a single item when the
/// gaps between them are small, so a dense (borderless) table row often arrives
/// as ONE item whose center would land in a single column. Instead of assigning
/// whole items by center, estimate each character's x position from the item's
/// advance width and keep the characters whose centers fall inside the column.
fn extract_line_segment(line: &[&TextElement], left: f64, right: f64) -> String {
  let mut out = String::new();
  for e in line {
    let chars: Vec<char> = e.text.chars().collect();
    if chars.is_empty() {
      continue;
    }
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
/// Returns sorted y values with implicit top (0) and bottom (page_height) boundaries.
fn build_row_boundaries(horizontal_lines: &[f64], page_height: f64) -> Vec<f64> {
  let mut boundaries: Vec<f64> = horizontal_lines.to_vec();
  boundaries.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
  boundaries.dedup();
  // Add implicit boundaries
  let mut result = vec![0.0];
  result.extend(boundaries);
  result.push(page_height);
  result
}

/// Extract table from a grid defined by both horizontal and vertical lines.
fn extract_table_from_grid(
  elements: &[TextElement],
  horizontal_lines: &[f64],
  vertical_lines: &[f64],
  page_width: f64,
  page_height: f64,
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

  // First row is the header
  let mut columns = Vec::with_capacity(ncols);
  for col in 0..ncols {
    let region = DrawTableRegion {
      x: col_bounds[col],
      y: row_bounds[0],
      width: col_bounds[col + 1] - col_bounds[col],
      height: row_bounds[1] - row_bounds[0],
    };
    columns.push(extract_cell_text(elements, &region));
  }

  // Data rows
  let mut rows = Vec::with_capacity(nrows.saturating_sub(1));
  for row in 1..nrows {
    let mut row_cells = Vec::with_capacity(ncols);
    for col in 0..ncols {
      let region = DrawTableRegion {
        x: col_bounds[col],
        y: row_bounds[row],
        width: col_bounds[col + 1] - col_bounds[col],
        height: row_bounds[row + 1] - row_bounds[row],
      };
      row_cells.push(extract_cell_text(elements, &region));
    }
    rows.push(row_cells);
  }

  MdTable {
    columns,
    rows,
    page: None,
  }
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
    let columns = vec!["列 1".to_string()];
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
      result.columns = vec!["内容".to_string()];
    }
    return result;
  }

  // Simple column detection: cluster x positions across all lines
  let first_line = &lines[0];
  // Use the first line's element count as a hint for column count
  let col_count_hint = first_line.len();

  if col_count_hint <= 1 {
    // Single column output
    let columns = vec!["内容".to_string()];
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
      result.columns = vec!["内容".to_string()];
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
      .map(|i| format!("列 {}", i + 1))
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
/// `use_cache` enables the full-document text cache (see [`cached_text_elements`]):
/// when on, the first extraction decodes the whole document and later calls
/// reuse it; when off, only the pages in the request are decoded each time.
pub fn extract_tables_from_draw_lines(
  path: &str,
  request: &DrawTableRequest,
  use_cache: bool,
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
    // Reuse an existing full-document cache if present (instant), otherwise
    // decode only the previewed pages and leave the cache untouched.
    let guard = TEXT_ITEM_CACHE.lock().unwrap();
    match guard.as_ref() {
      Some(cache) if cache.path == path => cache.items.clone(),
      _ => extract_text_elements(path, page_filter.as_ref())?,
    }
  } else {
    cached_text_elements(path)?
  };

  let effective_pages: Vec<PageDrawTable> = if use_for_all_pages {
    let template = template.unwrap();
    // Without a page limit the lines apply to every page, bounded by the last
    // page that actually has text items (avoids a separate full-document parse
    // just to read the page count).
    let total_pages = items.iter().map(|it| it.page).max().unwrap_or(0);
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

  let mut tables = Vec::new();
  let mut regions = Vec::new();

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
    let elements: Vec<TextElement> = to_text_elements(&items, page_num)
      .into_iter()
      .map(|mut e| {
        e.x -= origin_x;
        e.y -= origin_y;
        e
      })
      .collect();

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
  })
}

/// Extract tables and merge them into an existing Markdown document.
pub fn extract_tables_and_merge(
  path: &str,
  request: &DrawTableRequest,
  existing_markdown: Option<&str>,
  use_cache: bool,
) -> Result<String, String> {
  let result = extract_tables_from_draw_lines(path, request, use_cache)?;

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
  fn test_extract_cell_text_single_line() {
    let elements = vec![
      TextElement {
        text: "Hello".to_string(),
        x: 10.0,
        y: 100.0,
        width: 30.0,
        font_size: 12.0,
      },
      TextElement {
        text: "World".to_string(),
        x: 50.0,
        y: 100.0,
        width: 30.0,
        font_size: 12.0,
      },
    ];

    let region = DrawTableRegion {
      x: 0.0,
      y: 80.0,
      width: 200.0,
      height: 40.0,
    };
    let text = extract_cell_text(&elements, &region);
    assert_eq!(text, "Hello World");
  }

  #[test]
  fn test_extract_cell_text_empty_region() {
    let elements = vec![TextElement {
      text: "A".to_string(),
      x: 10.0,
      y: 100.0,
      width: 10.0,
      font_size: 12.0,
    }];

    let region = DrawTableRegion {
      x: 200.0,
      y: 200.0,
      width: 100.0,
      height: 100.0,
    };
    let text = extract_cell_text(&elements, &region);
    assert_eq!(text, "");
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

    let table = extract_table_from_vertical_lines(&elements, &[40.0, 76.0], 120.0, 150.0);
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
    let table = extract_table_from_vertical_lines(&elements, &[80.0, 180.0], 300.0, 150.0);
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
}
