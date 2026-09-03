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

/// Geometry of one rebuilt visual line, captured while grouping the positioned
/// items. Consumed by the paragraph-join policy (`core/paragraph.rs`) to tell
/// soft line breaks (same paragraph) apart from hard ones (paragraph boundary,
/// heading, list item, ...). Coordinates are PDF user space (origin bottom-left).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LineMeta {
  /// Vertical position of the line (PDF user-space y).
  pub y: f32,
  /// Font size in points, used to estimate the line height.
  pub font_size: f32,
  /// Leftmost x of the line's items.
  pub x0: f32,
  /// Rightmost edge (max item x + width).
  pub x1: f32,
}

/// The rebuilt markdown of one page plus the per-line geometry it was built
/// from. `line_meta` is `Some` only for pages whose markdown was reconstructed
/// from positioned items (one entry per non-empty output line, aligned 1:1
/// with `markdown.lines()`); table pages, OCR pages and empty pages keep their
/// original markdown and carry `None` (no reliable geometry).
#[derive(Debug, Clone)]
pub struct PageText {
  pub markdown: String,
  pub line_meta: Option<Vec<LineMeta>>,
}

impl PageText {
  /// A page whose markdown was not rebuilt from items (tables / OCR / empty).
  pub fn untouched(markdown: String) -> Self {
    Self {
      markdown,
      line_meta: None,
    }
  }
}

/// Rebuild the document markdown page by page, keeping every visual line on
/// its own line, returning one [`PageText`] per page (in document order).
///
/// * Pages that pdf-inspector already classified as containing a table
///   (`pages_with_tables`) or that need OCR are left untouched.
/// * Every other page is rebuilt: each visual line is kept on its own line
///   and its geometry is captured in [`PageText::line_meta`].
///
/// `separator` joins the text items that share a visual line (the app's
/// "text separator" setting, e.g. `"|"` for column layouts); an empty value
/// falls back to a single space so words never get glued together.
pub fn rebuild_pages(
  pages: &[pdf_inspector::PageMarkdown],
  items: &[TextItem],
  pages_with_tables: &[u32],
  separator: &str,
) -> Vec<PageText> {
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

    let text = if has_table || page.needs_ocr || page_items.is_empty() {
      PageText::untouched(page.markdown.clone())
    } else {
      let (markdown, meta) = lines_to_markdown_with_meta(&page_items, separator);
      PageText {
        markdown,
        line_meta: Some(meta),
      }
    };
    parts.push(text);
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
/// A table page touched by an exclusion is rebuilt from the surviving items as
/// a GFM table ([`lines_to_table_markdown`]) rather than plain text, so the
/// page is still recognised as a table after the excluded content is removed.
///
/// `line_meta` (parallel to `page_markdowns`, from the original extraction) is
/// carried through for untouched pages so their geometry survives an
/// exclusion that does not touch them; rebuilt pages get fresh meta.
pub fn rebuild_pages_excluding(
  page_markdowns: &[String],
  line_meta: &[Vec<LineMeta>],
  items: &[TextItem],
  pages_with_tables: &[u32],
  needs_ocr_flags: &[bool],
  spec: &ExcludeRegions,
  separator: &str,
) -> Vec<PageText> {
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
    let text = if keep_original {
      // Carry the original geometry through so paragraph joining still sees it.
      let meta = line_meta.get(i).cloned().unwrap_or_default();
      PageText {
        markdown: markdown.clone(),
        line_meta: if meta.is_empty() { None } else { Some(meta) },
      }
    } else if has_table {
      // An excluded table page is rebuilt as a GFM table so it is still
      // recognised as a table (instead of collapsing to text_separator-joined
      // plain text). The excluded items are already gone from `page_items`.
      PageText::untouched(lines_to_table_markdown(&page_items))
    } else {
      let (markdown, meta) = lines_to_markdown_with_meta(&page_items, separator);
      PageText {
        markdown,
        line_meta: Some(meta),
      }
    };
    parts.push(text);
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
#[cfg(test)]
fn group_lines<'a>(items: &[&'a TextItem]) -> Vec<Vec<&'a TextItem>> {
  group_lines_with_meta(items).0
}

/// Like [`group_lines`] but also returns the geometry of every **non-empty**
/// visual line, aligned 1:1 with the returned lines (empty lines carry no
/// output, so they are skipped in both vectors).
fn group_lines_with_meta<'a>(items: &[&'a TextItem]) -> (Vec<Vec<&'a TextItem>>, Vec<LineMeta>) {
  let mut sorted: Vec<&TextItem> = items.to_vec();
  sorted.sort_by(|a, b| b.y.total_cmp(&a.y).then_with(|| a.x.total_cmp(&b.x)));

  let mut lines: Vec<Vec<&TextItem>> = Vec::new();
  let mut metas: Vec<LineMeta> = Vec::new();
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
  for line in &lines {
    let x0 = line.iter().map(|it| it.x).fold(f32::INFINITY, f32::min);
    let x1 = line.iter().map(|it| it.x + it.width).fold(0.0f32, f32::max);
    let font_size = line
      .iter()
      .map(|it| it.font_size)
      .fold(0.0f32, f32::max)
      .max(1.0);
    let y = line.iter().map(|it| it.y).fold(f32::NEG_INFINITY, f32::max);
    metas.push(LineMeta {
      y,
      font_size,
      x0: if x0.is_finite() { x0 } else { 0.0 },
      x1: x1.max(x0),
    });
  }
  (lines, metas)
}

/// Group positioned items into rows of cells. Each visual line becomes a row;
/// within a line, items (and the multi-space column gaps inside a merged item)
/// are split into individual cells. Empty cells are dropped, and lines that
/// end up empty are skipped.
///
/// This is the shared backbone of [`lines_to_markdown`] (plain-text join) and
/// [`lines_to_table_markdown`] (GFM table), so both produce the same row/cell
/// structure from the same input.
fn group_cells(items: &[&TextItem]) -> Vec<Vec<String>> {
  group_cells_with_meta(items).0
}

/// Like [`group_cells`] but also returns the geometry of every non-empty row,
/// aligned 1:1 with the returned rows (only rows that survive into the output
/// get a [`LineMeta`], so `markdown.lines().count() == meta.len()` holds).
fn group_cells_with_meta(items: &[&TextItem]) -> (Vec<Vec<String>>, Vec<LineMeta>) {
  let (lines, line_metas) = group_lines_with_meta(items);
  let mut rows = Vec::with_capacity(lines.len());
  let mut metas = Vec::with_capacity(lines.len());
  for (line, meta) in lines.into_iter().zip(line_metas) {
    let mut cells: Vec<String> = Vec::new();
    for it in line {
      let trimmed = it.text.trim();
      match split_at_column_gaps(trimmed) {
        Some(parts) => cells.extend(parts),
        None => cells.push(trimmed.to_string()),
      }
    }
    cells.retain(|p| !p.is_empty());
    if !cells.is_empty() {
      rows.push(cells);
      metas.push(meta);
    }
  }
  (rows, metas)
}

/// Render every visual line as its own markdown line, joining the line's cells
/// with `separator` (see [`rebuild_pages`]); an empty separator collapses
/// to a single space.
///
/// PDF producers often write each row of a borderless grid as one text run, so
/// pdf-inspector returns a single item whose cells are separated by runs of
/// extra spaces. Those runs are split into cells here (`split_at_column_gaps`),
/// so the separator appears between the columns of every row - not just rows
/// whose cells happen to be separate items.
#[cfg(test)]
fn lines_to_markdown(items: &[&TextItem], separator: &str) -> String {
  lines_to_markdown_with_meta(items, separator).0
}

/// Like [`lines_to_markdown`] but also returns the per-line geometry of every
/// output line, aligned 1:1 with `markdown.lines()` (empty rows are skipped in
/// both). Used to carry geometry into the paragraph-join policy.
fn lines_to_markdown_with_meta(items: &[&TextItem], separator: &str) -> (String, Vec<LineMeta>) {
  let join = if separator.trim().is_empty() {
    " "
  } else {
    separator
  };
  let (rows, metas) = group_cells_with_meta(items);
  let markdown = rows
    .iter()
    .map(|cells| cells.join(join))
    .collect::<Vec<_>>()
    .join("\n");
  (markdown, metas)
}

/// Rebuild a page as a GFM table from its positioned items, used when an
/// exclusion region touches a table page (see [`rebuild_pages_excluding`]).
///
/// The original GFM table produced by pdf-inspector cannot be filtered by
/// region, so instead the surviving items (exclusion already applied by
/// [`region_exclude::filter_items`]) are regrouped into rows and cells by
/// [`group_cells`] and emitted as a fresh GFM table: the first row is the
/// header, followed by the `---` delimiter, then the data rows. Shorter rows
/// are padded with empty cells so every row has the same column count.
///
/// This keeps the page recognised as a table (the bug where an all-table PDF
/// collapsed to `text_separator`-joined plain text on the excluded page) while
/// still honouring the exclusion - the dropped items simply vanish from the
/// rebuilt table.
fn lines_to_table_markdown(items: &[&TextItem]) -> String {
  let rows = group_cells(items);
  if rows.is_empty() {
    return String::new();
  }
  let ncols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
  if ncols == 0 {
    return String::new();
  }
  let padded: Vec<Vec<String>> = rows
    .iter()
    .map(|r| {
      let mut row = r.clone();
      while row.len() < ncols {
        row.push(String::new());
      }
      row
    })
    .collect();

  let mut out = String::new();
  out.push('|');
  for cell in &padded[0] {
    out.push(' ');
    out.push_str(cell);
    out.push_str(" |");
  }
  out.push('\n');
  out.push('|');
  for _ in 0..ncols {
    out.push_str(" --- |");
  }
  out.push('\n');
  for row in &padded[1..] {
    out.push('|');
    for cell in row {
      out.push(' ');
      out.push_str(cell);
      out.push_str(" |");
    }
    out.push('\n');
  }
  // Match lines_to_markdown: no trailing newline.
  if out.ends_with('\n') {
    out.pop();
  }
  out
}

/// Split `text` at runs of 2+ consecutive whitespace characters (the visible
/// column gaps left by single-run rows). `char::is_whitespace` covers ASCII
/// space, the full-width U+3000 and the non-breaking U+00A0, so CJK rows
/// separated by full-width spaces (`姓名　　年龄`) split correctly. Pieces are
/// trimmed and empty ones dropped; returns `None` when there is no such run, so
/// a single intact cell keeps its exact text (single spaces inside a cell /
/// normal prose stay untouched).
fn split_at_column_gaps(text: &str) -> Option<Vec<String>> {
  let chars: Vec<char> = text.chars().collect();
  let mut cells: Vec<String> = Vec::new();
  let mut seg_start = 0usize;
  let mut i = 0usize;
  while i < chars.len() {
    if chars[i].is_whitespace() && i + 1 < chars.len() && chars[i + 1].is_whitespace() {
      let cell: String = chars[seg_start..i].iter().collect();
      if !cell.trim().is_empty() {
        cells.push(cell.trim().to_string());
      }
      while i < chars.len() && chars[i].is_whitespace() {
        i += 1;
      }
      seg_start = i;
    } else {
      i += 1;
    }
  }
  let last: String = chars[seg_start..].iter().collect();
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

  /// CJK / latin rows separated by full-width (U+3000) or non-breaking runs
  /// split into columns too, not just ASCII double-space runs.
  #[test]
  fn full_width_and_nbsp_runs_split_cjk_columns() {
    assert_eq!(
      split_at_column_gaps("姓名　　年龄　　部门"),
      Some(vec![
        "姓名".to_string(),
        "年龄".to_string(),
        "部门".to_string()
      ])
    );
    assert_eq!(
      split_at_column_gaps("P1\u{a0}\u{a0}P2"),
      Some(vec!["P1".to_string(), "P2".to_string()])
    );
    // A single space (half or full width) inside a cell / prose is untouched.
    assert_eq!(split_at_column_gaps("hello world"), None);
    assert_eq!(split_at_column_gaps("你好 世界"), None);
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

  // ─── group_cells / lines_to_table_markdown ──────────────────────────────

  #[test]
  fn group_cells_splits_rows_and_columns() {
    let items = grid_items();
    let refs: Vec<&TextItem> = items.iter().collect();
    let rows = group_cells(&refs);
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0], vec!["姓名", "年龄", "城市"]);
    assert_eq!(rows[1], vec!["张三", "28", "北京"]);
    assert_eq!(rows[2], vec!["李四", "35", "上海"]);
  }

  /// Merged single-item rows (one text run with multi-space column gaps) are
  /// split into cells the same way plain rows are, so the GFM table stays
  /// rectangular.
  #[test]
  fn group_cells_splits_merged_rows() {
    let items = vec![
      item("Name", 72.0, 790.0, 32.0, 12.0),
      item("Age", 190.0, 790.0, 21.0, 12.0),
      item("City", 310.0, 790.0, 21.0, 12.0),
      item("Alice    28    Beijing", 72.0, 770.0, 102.0, 12.0),
      item("Bob    35    Shanghai", 72.0, 750.0, 112.0, 12.0),
    ];
    let refs: Vec<&TextItem> = items.iter().collect();
    let rows = group_cells(&refs);
    assert_eq!(rows[0], vec!["Name", "Age", "City"]);
    assert_eq!(rows[1], vec!["Alice", "28", "Beijing"]);
    assert_eq!(rows[2], vec!["Bob", "35", "Shanghai"]);
  }

  #[test]
  fn lines_to_table_markdown_emits_valid_gfm() {
    let items = grid_items();
    let refs: Vec<&TextItem> = items.iter().collect();
    let md = lines_to_table_markdown(&refs);
    let expected = "\
| 姓名 | 年龄 | 城市 |
| --- | --- | --- |
| 张三 | 28 | 北京 |
| 李四 | 35 | 上海 |";
    assert_eq!(md, expected);
  }

  /// Shorter rows are padded with empty cells so the table stays rectangular
  /// even after an exclusion removes a cell from some rows.
  #[test]
  fn lines_to_table_markdown_pads_uneven_rows() {
    let items = vec![
      item("A", 72.0, 790.0, 10.0, 12.0),
      item("B", 150.0, 790.0, 10.0, 12.0),
      item("C", 72.0, 770.0, 10.0, 12.0),
      // Second row has only one cell - padded to two columns.
    ];
    let refs: Vec<&TextItem> = items.iter().collect();
    let md = lines_to_table_markdown(&refs);
    let expected = "\
| A | B |
| --- | --- |
| C |  |";
    assert_eq!(md, expected);
  }

  #[test]
  fn lines_to_table_markdown_empty_items_yields_empty_string() {
    let refs: Vec<&TextItem> = Vec::new();
    assert_eq!(lines_to_table_markdown(&refs), "");
  }

  // ─── rebuild_pages_excluding: table pages stay tables ───────────────────

  /// Regression for the reported bug: a text-type PDF that is entirely tables,
  /// when an exclusion region is drawn on the first page, must keep that page
  /// as a GFM table - not collapse to `text_separator`-joined plain text.
  #[test]
  fn excluded_table_page_is_rebuilt_as_gfm_table_not_plain_text() {
    let items = grid_items();
    let original_md =
      "| 姓名 | 年龄 | 城市 |\n| --- | --- | --- |\n| 张三 | 28 | 北京 |\n| 李四 | 35 | 上海 |";
    let spec = ExcludeRegions {
      pages: vec![crate::models::PageExclude {
        page: 1,
        // Exclude the 城市/北京/上海 column (right band).
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
    let out = rebuild_pages_excluding(
      &[original_md.to_string()],
      &[Vec::new()],
      &items,
      &[1],     // page 1 is a table page
      &[false], // text page, no OCR
      &spec,
      "|",
    );
    assert_eq!(out.len(), 1);
    // The page is still a GFM table (has the delimiter row), and the excluded
    // 城市 column is gone.
    let expected = "\
| 姓名 | 年龄 |
| --- | --- |
| 张三 | 28 |
| 李四 | 35 |";
    assert_eq!(out[0].markdown, expected);
  }

  /// A non-table excluded page still degrades to plain-text lines (the existing
  /// behaviour is unchanged - only table pages get the GFM rebuild).
  #[test]
  fn excluded_non_table_page_still_uses_plain_text_lines() {
    let items = vec![
      item("hello", 72.0, 790.0, 40.0, 12.0),
      item("world", 72.0, 770.0, 40.0, 12.0),
    ];
    let spec = ExcludeRegions {
      pages: vec![crate::models::PageExclude {
        page: 1,
        // Band covers only "hello" (y≈790-802); "world" (y≈770-782) is below it.
        rects: vec![crate::models::RegionRect {
          x: 0.0,
          y: 800.0,
          width: 595.0,
          height: 20.0,
        }],
        page_x: 0.0,
        page_y: 0.0,
        page_width: 595.0,
        page_height: 842.0,
      }],
      use_for_all_pages: None,
      total_pages: Some(1),
    };
    let out = rebuild_pages_excluding(
      &["hello\nworld".to_string()],
      &[Vec::new()],
      &items,
      &[], // no table pages
      &[false],
      &spec,
      "|",
    );
    // "hello" was excluded; "world" survives as a plain line, not a table.
    assert_eq!(out[0].markdown, "world");
  }

  /// A table page that is NOT excluded keeps its original markdown verbatim
  /// (the exclusion must not touch untouched table pages).
  #[test]
  fn non_excluded_table_page_keeps_original_markdown() {
    let items = grid_items();
    let original_md = "| 姓名 | 年龄 | 城市 |\n| --- | --- | --- |\n| 张三 | 28 | 北京 |";
    let spec = ExcludeRegions {
      pages: vec![crate::models::PageExclude {
        page: 2, // exclusion is on page 2, not page 1
        rects: vec![crate::models::RegionRect {
          x: 0.0,
          y: 0.0,
          width: 100.0,
          height: 100.0,
        }],
        page_x: 0.0,
        page_y: 0.0,
        page_width: 595.0,
        page_height: 842.0,
      }],
      use_for_all_pages: None,
      total_pages: Some(2),
    };
    let out = rebuild_pages_excluding(
      &[original_md.to_string(), "page two".to_string()],
      &[Vec::new(), Vec::new()],
      &items,
      &[1],
      &[false, false],
      &spec,
      "|",
    );
    assert_eq!(out[0].markdown, original_md);
  }
}
