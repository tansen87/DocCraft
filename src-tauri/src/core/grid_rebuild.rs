//! Fallback layout reconstruction for PDFs where pdf-inspector merges a
//! borderless grid into a single paragraph.
//!
//! pdf-inspector only emits a GFM table when its own heuristic finds enough
//! evidence of a table. When it does not, every visual line inside a paragraph
//! is joined with a space and the whole page collapses into one long line.
//! This module re-groups the positioned [`TextItem`]s back into visual lines.

use pdf_inspector::TextItem;
use pdf_inspector::extractor::ItemType;

use crate::core::page_marker::page_marker;
use crate::core::region_exclude;
use crate::models::ExcludeRegions;

/// Rebuild the document markdown page by page, keeping every visual line on
/// its own line, returning one markdown string per page (in document order).
///
/// * Pages that pdf-inspector already classified as containing a table
///   (`pages_with_tables`) or that need OCR are left untouched.
/// * Every other page is rebuilt: each visual line is kept on its own line.
///
/// `separator` joins the text items that share a visual line (the app's
/// "text separator" setting, e.g. `"|"` for column layouts); an empty value
/// falls back to a single space so words never get glued together.
pub fn rebuild_pages(
  pages: &[pdf_inspector::PageMarkdown],
  items: &[TextItem],
  pages_with_tables: &[u32],
  separator: &str,
) -> Vec<String> {
  let mut parts = Vec::with_capacity(pages.len());
  for page in pages {
    let page_no = page.page + 1;
    let has_table = pages_with_tables.contains(&page_no);
    let page_items: Vec<&TextItem> = items
      .iter()
      .filter(|it| {
        it.page == page_no
          && matches!(it.item_type, ItemType::Text | ItemType::FormField)
          && !it.text.trim().is_empty()
      })
      .collect();

    let markdown = if has_table || page.needs_ocr || page_items.is_empty() {
      page.markdown.clone()
    } else {
      lines_to_markdown(&page_items, separator)
    };
    parts.push(markdown);
  }
  parts
}

/// Same as [`rebuild_pages`] but with user-drawn exclusion regions applied:
/// text items that intersect an excluded rectangle are dropped before the
/// visual lines are regrouped.
///
/// Only pages that carry at least one rect are re-rendered, so a document
/// without exclusions produces byte-identical output to [`rebuild_pages`].
///
/// Pages flagged `needs_ocr` keep their markdown: their content comes from the
/// OCR pipeline, where the frontend masks the excluded rects on the rendered
/// image instead.
///
/// A table page touched by an exclusion loses its GFM table - the whole-page
/// table markdown cannot be filtered by region, so the page is rebuilt from
/// the remaining items as plain text lines (documented trade-off).
pub fn rebuild_pages_excluding(
  page_markdowns: &[String],
  items: &[TextItem],
  pages_with_tables: &[u32],
  needs_ocr_flags: &[bool],
  spec: &ExcludeRegions,
  separator: &str,
) -> Vec<String> {
  let page_count = page_markdowns.len() as u32;
  let filters = region_exclude::page_filters(spec, page_count);
  let kept = region_exclude::filter_items(items, &filters);
  let mut parts = Vec::with_capacity(page_markdowns.len());
  for (i, markdown) in page_markdowns.iter().enumerate() {
    let page_no = (i + 1) as u32;
    let has_table = pages_with_tables.contains(&page_no);
    let needs_ocr = needs_ocr_flags.get(i).copied().unwrap_or(false);
    let excluded = filters.get(&page_no).is_some_and(|r| !r.is_empty());
    let page_items: Vec<&TextItem> = kept
      .iter()
      .filter(|it| {
        it.page == page_no
          && matches!(it.item_type, ItemType::Text | ItemType::FormField)
          && !it.text.trim().is_empty()
      })
      .collect();

    // Untouched pages follow the normal path (tables and OCR pages keep their
    // markdown); an excluded page is rebuilt unless its content comes from OCR.
    let keep_original = if excluded {
      needs_ocr
    } else {
      has_table || needs_ocr || page_items.is_empty()
    };
    if keep_original {
      parts.push(markdown.clone());
    } else {
      parts.push(lines_to_markdown(&page_items, separator));
    }
  }
  parts
}

/// Pages that truly need OCR: detection-flagged pages plus any page whose
/// rebuilt markdown is empty (image-only pages the detector can miss).
/// Derived from the real extraction, so the result is independent of whether
/// OCR is enabled.
pub fn merge_ocr_pages(detected: &[u32], page_markdowns: &[String]) -> Vec<u32> {
  let mut pages: Vec<u32> = detected.to_vec();
  for (i, md) in page_markdowns.iter().enumerate() {
    if md.trim().is_empty() {
      pages.push((i + 1) as u32);
    }
  }
  pages.sort_unstable();
  pages.dedup();
  pages
}

/// Rebuild a markdown document from only the given 1-indexed pages, keeping
/// each page's **original** document page number in its `<!-- Page N -->`
/// marker regardless of the range, so downstream page attribution (e.g. the
/// Markdown > Excel export) is unaffected. Pages are emitted in ascending order.
pub fn rebuild_document_for_pages(page_markdowns: &[String], pages: &[u32]) -> String {
  pages
    .iter()
    .filter(|p| **p >= 1 && **p <= page_markdowns.len() as u32)
    .map(|p| {
      let md = page_markdowns
        .get((*p - 1) as usize)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
      format!("{}\n\n{md}", page_marker(*p))
    })
    .collect::<Vec<_>>()
    .join("\n\n")
}

/// Parse a page-range spec (`"1-5,8,12-14"`) into a sorted, deduped list of
/// 1-indexed page numbers, clamped to `page_count`. Returns `None` for an
/// empty/blank spec (meaning "the whole document"). Malformed tokens are
/// skipped; if no token yields a valid page the function falls back to `None`.
pub fn parse_page_range(spec: Option<&str>, page_count: u32) -> Option<Vec<u32>> {
  let spec = spec?.trim();
  if spec.is_empty() {
    return None;
  }
  let mut pages: Vec<u32> = Vec::new();
  for token in spec.split(',') {
    let token = token.trim();
    if token.is_empty() {
      continue;
    }
    if let Some((a, b)) = token.split_once('-') {
      let Ok(a) = a.trim().parse::<u32>() else {
        continue;
      };
      let Ok(b) = b.trim().parse::<u32>() else {
        continue;
      };
      let (lo, hi) = (a.min(b), a.max(b));
      for p in lo..=hi {
        if p >= 1 && p <= page_count {
          pages.push(p);
        }
      }
    } else if let Ok(p) = token.parse::<u32>() {
      if p >= 1 && p <= page_count {
        pages.push(p);
      }
    }
  }
  pages.sort_unstable();
  pages.dedup();
  if pages.is_empty() { None } else { Some(pages) }
}

/// Group positioned items into visual lines (top-to-bottom, then left-to-right).
fn group_lines<'a>(items: &[&'a TextItem]) -> Vec<Vec<&'a TextItem>> {
  let mut sorted: Vec<&TextItem> = items.to_vec();
  sorted.sort_by(|a, b| b.y.total_cmp(&a.y).then_with(|| a.x.total_cmp(&b.x)));

  let mut lines: Vec<Vec<&TextItem>> = Vec::new();
  let mut line_y: Option<f32> = None;
  let mut line_font: f32 = 12.0;
  for item in sorted {
    if let Some(y) = line_y {
      let tolerance = (line_font * 0.5).max(3.0);
      if (item.y - y).abs() <= tolerance {
        lines.last_mut().expect("line exists").push(item);
        continue;
      }
    }
    lines.push(vec![item]);
    line_y = Some(item.y);
    line_font = item.font_size.max(1.0);
  }
  for line in &mut lines {
    line.sort_by(|a, b| a.x.total_cmp(&b.x));
  }
  lines
}

/// Render every visual line as its own markdown line, joining the line's text
/// items with `separator` (see [`rebuild_pages`]); an empty separator collapses
/// to a single space.
///
/// PDF producers often write each row of a borderless grid as one text run, so
/// pdf-inspector returns a single item whose cells are separated by runs of
/// extra spaces. Those runs are split into cells here (`split_at_column_gaps`),
/// so the separator appears between the columns of every row - not just rows
/// whose cells happen to be separate items.
fn lines_to_markdown(items: &[&TextItem], separator: &str) -> String {
  let join = if separator.trim().is_empty() {
    " "
  } else {
    separator
  };
  let lines = group_lines(items);
  let mut out = Vec::new();
  for line in lines {
    let mut pieces: Vec<String> = Vec::new();
    for it in line {
      let trimmed = it.text.trim();
      match split_at_column_gaps(trimmed) {
        Some(cells) => pieces.extend(cells),
        None => pieces.push(trimmed.to_string()),
      }
    }
    pieces.retain(|p| !p.is_empty());
    if pieces.is_empty() {
      continue;
    }
    out.push(pieces.join(join));
  }
  out.join("\n")
}

/// Split `text` at runs of 2+ consecutive spaces (the visible column gaps left
/// by single-run rows). Pieces are trimmed and empty ones dropped; returns
/// `None` when there is no such run, so a single intact cell keeps its exact
/// text (single spaces inside a cell / normal prose stay untouched).
fn split_at_column_gaps(text: &str) -> Option<Vec<String>> {
  let bytes = text.as_bytes();
  let mut cells: Vec<String> = Vec::new();
  let mut seg_start = 0usize;
  let mut i = 0usize;
  while i < bytes.len() {
    if bytes[i] == b' ' && i + 1 < bytes.len() && bytes[i + 1] == b' ' {
      let cell = &text[seg_start..i];
      if !cell.trim().is_empty() {
        cells.push(cell.trim().to_string());
      }
      while i < bytes.len() && bytes[i] == b' ' {
        i += 1;
      }
      seg_start = i;
    } else {
      i += 1;
    }
  }
  let last = &text[seg_start..];
  if !last.trim().is_empty() {
    cells.push(last.trim().to_string());
  }
  if cells.len() >= 2 { Some(cells) } else { None }
}

#[cfg(test)]
mod tests {
  use super::*;
  use pdf_inspector::extractor::ItemType;

  fn item(text: &str, x: f32, y: f32, width: f32, font_size: f32) -> TextItem {
    TextItem {
      text: text.to_string(),
      x,
      y,
      width,
      height: font_size,
      font: "F".to_string(),
      font_size,
      page: 1,
      is_bold: false,
      is_italic: false,
      is_underline: false,
      is_strikeout: false,
      item_type: ItemType::Text,
      mcid: None,
      font_tag: "F2".to_string(),
    }
  }

  fn grid_items() -> Vec<TextItem> {
    vec![
      item("姓名", 72.0, 800.0, 24.0, 12.0),
      item("年龄", 240.0, 800.0, 24.0, 12.0),
      item("城市", 360.0, 800.0, 24.0, 12.0),
      item("张三", 72.0, 780.0, 24.0, 12.0),
      item("28", 240.0, 780.0, 16.0, 12.0),
      item("北京", 360.0, 780.0, 24.0, 12.0),
      item("李四", 72.0, 760.0, 24.0, 12.0),
      item("35", 240.0, 760.0, 16.0, 12.0),
      item("上海", 360.0, 760.0, 24.0, 12.0),
    ]
  }

  #[test]
  fn groups_into_visual_lines() {
    let items = grid_items();
    let refs: Vec<&TextItem> = items.iter().collect();
    let lines = group_lines(&refs);
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0][0].text, "姓名");
  }

  #[test]
  fn line_breaks_preserve_each_row() {
    let items = grid_items();
    let refs: Vec<&TextItem> = items.iter().collect();
    let md = lines_to_markdown(&refs, " ");
    assert_eq!(md, "姓名 年龄 城市\n张三 28 北京\n李四 35 上海");
  }

  /// The configured text separator (default `|`, the app's "连接符") joins the
  /// items of a visual line, mirroring what the OCR engine does for OCR boxes.
  #[test]
  fn text_separator_joins_same_line_items() {
    let items = grid_items();
    let refs: Vec<&TextItem> = items.iter().collect();
    assert_eq!(
      lines_to_markdown(&refs, "|"),
      "姓名|年龄|城市\n张三|28|北京\n李四|35|上海"
    );
    // A blank separator falls back to a space so words never glue together.
    assert_eq!(
      lines_to_markdown(&refs, ""),
      "姓名 年龄 城市\n张三 28 北京\n李四 35 上海"
    );
  }

  /// Rows that pdf-inspector merged into a single item (written as one text
  /// run with visible multi-space column gaps) must still get the separator on
  /// every row's columns, exactly like the per-cell header row.
  #[test]
  fn merged_rows_split_at_column_gaps_and_get_the_separator() {
    let items = vec![
      item("Name", 72.0, 790.0, 32.0, 12.0),
      item("Age", 190.0, 790.0, 21.0, 12.0),
      item("City", 310.0, 790.0, 21.0, 12.0),
      item("Alice    28    Beijing", 72.0, 770.0, 102.0, 12.0),
      item("Bob    35    Shanghai", 72.0, 750.0, 112.0, 12.0),
    ];
    let refs: Vec<&TextItem> = items.iter().collect();
    assert_eq!(
      lines_to_markdown(&refs, "|"),
      "Name|Age|City\nAlice|28|Beijing\nBob|35|Shanghai"
    );
  }

  /// A single space between words is normal spacing, not a column gap: prose
  /// and CW/CJK lines must not be fragmented by the splitter.
  #[test]
  fn single_space_runs_are_left_alone() {
    let items = vec![item("This is prose", 72.0, 790.0, 80.0, 12.0)];
    let refs: Vec<&TextItem> = items.iter().collect();
    assert_eq!(lines_to_markdown(&refs, "|"), "This is prose");
    // No leading/trailing garbage either.
    let items2 = vec![item("  padded   ", 72.0, 790.0, 60.0, 12.0)];
    let refs2: Vec<&TextItem> = items2.iter().collect();
    assert_eq!(lines_to_markdown(&refs2, "|"), "padded");
  }

  #[test]
  fn parse_page_range_handles_specs() {
    // Blank spec => whole document (None).
    assert_eq!(parse_page_range(None, 20), None);
    assert_eq!(parse_page_range(Some("   "), 20), None);
    // Basic ranges, single pages, mixing, clamping and dedup.
    assert_eq!(parse_page_range(Some("1-5"), 20), Some(vec![1, 2, 3, 4, 5]));
    assert_eq!(
      parse_page_range(Some("1-5,8,12-14"), 20),
      Some(vec![1, 2, 3, 4, 5, 8, 12, 13, 14])
    );
    // Reversed range and clamping to page_count (20 is the max).
    assert_eq!(
      parse_page_range(Some("5-2,30,20"), 20),
      Some(vec![2, 3, 4, 5, 20])
    );
    // Numbers out of range and 0 are dropped.
    assert_eq!(parse_page_range(Some("0,99,3"), 10), Some(vec![3]));
    // Malformed tokens are skipped; when nothing parses, None.
    assert_eq!(parse_page_range(Some("x,y"), 10), None);
  }

  #[test]
  fn excluding_a_column_keeps_the_other_columns() {
    // A 3x3 grid where the last column (城市/北京/上海) is excluded via a
    // full-height band on the right side of the page.
    let items = grid_items();
    let spec = ExcludeRegions {
      pages: vec![crate::models::PageExclude {
        page: 1,
        rects: vec![crate::models::RegionRect {
          x: 340.0,
          y: 0.0,
          width: 260.0,
          height: 900.0,
        }],
        page_x: 0.0,
        page_y: 0.0,
        page_width: 595.0,
        page_height: 842.0,
      }],
      use_for_all_pages: None,
      total_pages: Some(1),
    };
    let kept = region_exclude::filter_items(&items, &region_exclude::page_filters(&spec, 1));
    let refs: Vec<&TextItem> = kept.iter().collect();
    let md = lines_to_markdown(&refs, " ");
    let expected = "姓名 年龄\n张三 28\n李四 35";
    assert_eq!(md, expected);
  }

  #[test]
  fn rebuild_document_for_pages_keeps_original_numbers() {
    let markdowns = vec![
      "page one".to_string(),
      "page two".to_string(),
      "page three".to_string(),
      "page four".to_string(),
    ];
    let md = rebuild_document_for_pages(&markdowns, &[2, 4]);
    assert_eq!(
      md,
      "<!-- Page 2 -->\n\npage two\n\n<!-- Page 4 -->\n\npage four"
    );
    // Out-of-range pages are ignored.
    let md2 = rebuild_document_for_pages(&markdowns, &[1, 99]);
    assert_eq!(md2, "<!-- Page 1 -->\n\npage one");
  }
}
