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

/// Rebuild the document markdown page by page, keeping every visual line on
/// its own line, returning one markdown string per page (in document order).
///
/// * Pages that pdf-inspector already classified as containing a table
///   (`pages_with_tables`) or that need OCR are left untouched.
/// * Every other page is rebuilt: each visual line is kept on its own line.
pub fn rebuild_pages(
  pages: &[pdf_inspector::PageMarkdown],
  items: &[TextItem],
  pages_with_tables: &[u32],
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
      lines_to_markdown(&page_items)
    };
    parts.push(markdown);
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

/// Render every visual line as its own markdown line.
fn lines_to_markdown(items: &[&TextItem]) -> String {
  let lines = group_lines(items);
  let mut out = Vec::new();
  for line in lines {
    let text: Vec<&str> = line.iter().map(|it| it.text.trim()).collect();
    if text.is_empty() {
      continue;
    }
    out.push(text.join(" "));
  }
  out.join("\n")
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
    let md = lines_to_markdown(&refs);
    assert_eq!(md, "姓名 年龄 城市\n张三 28 北京\n李四 35 上海");
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
