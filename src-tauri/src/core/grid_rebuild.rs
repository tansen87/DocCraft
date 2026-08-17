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

/// Convenience wrapper around [`rebuild_pages`] that joins pages with a blank
/// line, matching pdf-inspector's document-level output, and prefixes every
/// page with a `<!-- Page N -->` marker so downstream tooling can attribute
/// content (e.g. tables) to its source PDF page.
pub fn rebuild_document(
  pages: &[pdf_inspector::PageMarkdown],
  items: &[TextItem],
  pages_with_tables: &[u32],
) -> String {
  rebuild_pages(pages, items, pages_with_tables)
    .into_iter()
    .enumerate()
    .map(|(i, page)| format!("{}\n\n{page}", page_marker(i as u32 + 1)))
    .collect::<Vec<_>>()
    .join("\n\n")
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
}
