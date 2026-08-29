//! Exclusion regions: drop the content of user-drawn rectangles from recognition.
//!
//! Recognition runs through two independent pipelines (see
//! `docs/design/00010_pdf-exclude-region.md`):
//!
//! * **OCR pages** are rendered by the frontend, which paints the excluded
//!   rects white before the PNG is handed to the backend - no backend work.
//! * **Text-layer pages** are extracted by pdf-inspector into positioned
//!   [`TextItem`]s. Those items are filtered here and the page markdown is
//!   rebuilt from what remains.
//!
//! The line-draw pipeline (`core::line_draw`, see
//! `docs/design/00011_draw-line-exclude-region.md`) reuses the same rects for
//! its own positioned text elements. It already shifts those elements into
//! viewport-relative space, so it compares them against [`rects_for_page`]
//! directly - only the conversion pipeline needs [`page_filters`].
//!
//! Coordinate spaces (the single easiest thing to get wrong):
//!
//! * Rects arrive in **viewport-relative** PDF points with the origin at the
//!   lower-left corner of the pdf.js viewBox (identical to `PageDrawTable`).
//! * pdf-inspector coordinates are **absolute user space**, so rects are
//!   shifted by the page origin `(page_x, page_y)` before any comparison.
//! * `TextItem.y` is the bottom edge; the vertical extent is the larger of
//!   `height` and `font_size` so ascenders/descenders are covered.

use std::collections::HashMap;

use pdf_inspector::TextItem;

use crate::models::{ExcludeRegions, RegionRect};

/// Rects that apply to `page`, in viewport-relative PDF points, clamped to the
/// page's own size.
///
/// A page carrying its own entry always wins (even when its `rects` list is
/// empty). Otherwise, when `use_for_all_pages` is set, the first page with
/// rects acts as the template for every page.
pub fn rects_for_page(spec: &ExcludeRegions, page: u32) -> Vec<RegionRect> {
  if let Some(entry) = spec.pages.iter().find(|p| p.page == page) {
    return clamp_all(&entry.rects, entry.page_width, entry.page_height);
  }
  if !spec.use_for_all_pages.unwrap_or(false) {
    return Vec::new();
  }
  let Some(template) = spec.pages.iter().find(|p| !p.rects.is_empty()) else {
    return Vec::new();
  };
  clamp_all(&template.rects, template.page_width, template.page_height)
}

/// Per-page rects in **absolute user space**, keyed by 1-indexed page number.
/// Pages without any rect are absent from the map.
pub fn page_filters(spec: &ExcludeRegions, page_count: u32) -> HashMap<u32, Vec<RegionRect>> {
  let mut map = HashMap::new();
  if spec.pages.is_empty() {
    return map;
  }
  let last = spec.total_pages.unwrap_or(page_count).max(page_count);
  for page in 1..=last {
    let rects = rects_for_page(spec, page);
    if rects.is_empty() {
      continue;
    }
    let (origin_x, origin_y) = origin_for(spec, page);
    let shifted = rects
      .iter()
      .map(|r| RegionRect {
        x: r.x + origin_x,
        y: r.y + origin_y,
        width: r.width,
        height: r.height,
      })
      .collect();
    map.insert(page, shifted);
  }
  map
}

/// True when the item's bounding box intersects one of the rects, which are
/// expected to be in absolute user space (see [`page_filters`]).
pub fn hits_item(rects: &[RegionRect], it: &TextItem) -> bool {
  hits_box(
    rects,
    it.x as f64,
    it.y as f64,
    it.width as f64,
    (it.height as f64).max(it.font_size as f64),
  )
}

/// True when a box intersects one of the rects. Both sides must live in the
/// same coordinate space: [`page_filters`] rects for absolute user space, or
/// [`rects_for_page`] rects for viewport-relative points - the line-draw
/// pipeline already shifts its elements into that space, so it compares them
/// against the un-shifted rects directly.
pub fn hits_box(rects: &[RegionRect], left: f64, bottom: f64, width: f64, height: f64) -> bool {
  let right = left + width;
  let top = bottom + height;
  rects
    .iter()
    .any(|r| left < r.x + r.width && right > r.x && bottom < r.y + r.height && top > r.y)
}

/// Remove the excluded content from a list of text items, keeping every item
/// that survives in its original order. Pass the map built by [`page_filters`].
///
/// pdf-inspector merges runs on a visual line, so one item can span several
/// columns of a borderless grid (e.g. a report line "Alice  28  Beijing").
/// Dropping the whole item when a column band overlaps it would erase entire
/// rows; instead the overlapped characters are removed and the remaining
/// pieces are kept, so only the excluded column's text disappears. A rect
/// that covers the item's full horizontal span still removes it entirely
/// (the header/footer use case).
pub fn filter_items(items: &[TextItem], filters: &HashMap<u32, Vec<RegionRect>>) -> Vec<TextItem> {
  if filters.is_empty() {
    return items.to_vec();
  }
  let mut out = Vec::with_capacity(items.len());
  for it in items {
    let Some(rects) = filters.get(&it.page) else {
      out.push(it.clone());
      continue;
    };
    if !hits_item(rects, it) {
      out.push(it.clone());
      continue;
    }
    out.extend(split_outside(rects, it));
  }
  out
}

/// Split `it` into items carrying only the characters outside every rect.
fn split_outside(rects: &[RegionRect], it: &TextItem) -> Vec<TextItem> {
  let height = (it.height as f64).max(it.font_size as f64);
  split_box_outside(
    rects,
    it.x as f64,
    it.y as f64,
    it.width as f64,
    height,
    &it.text,
  )
  .into_iter()
  .map(|(x, width, text)| TextItem {
    x: x as f32,
    width: width as f32,
    text,
    ..it.clone()
  })
  .collect()
}

/// Pieces of `text` that fall outside every rect, as `(left, width, text)`.
///
/// Returns the text unchanged when nothing intersects, and nothing when the
/// rects cover the whole box. Each piece keeps the x it occupies in the source
/// box, so callers that assign content to columns by x - the line-draw
/// pipeline maps a drawn vertical line to a column - still put every piece in
/// its original column instead of shifting the right-hand ones left.
///
/// Neither pipeline carries per-glyph geometry, so each character is assumed
/// to be `width / char_count` wide. Whitespace-only pieces are dropped; the
/// rects and the box must live in the same space (see [`hits_box`]).
pub fn split_box_outside(
  rects: &[RegionRect],
  left: f64,
  bottom: f64,
  width: f64,
  height: f64,
  text: &str,
) -> Vec<(f64, f64, String)> {
  let chars: Vec<char> = text.chars().collect();
  if chars.is_empty() || width <= 0.0 {
    return Vec::new();
  }
  if !hits_box(rects, left, bottom, width, height) {
    return vec![(left, width, text.to_string())];
  }
  let advance = width / chars.len() as f64;
  // Kept runs as (first char index, kept text).
  let mut runs: Vec<(usize, String)> = Vec::new();
  for (idx, ch) in chars.iter().enumerate() {
    let x0 = left + idx as f64 * advance;
    let x1 = x0 + advance;
    if rects.iter().any(|r| x0 < r.x + r.width && x1 > r.x) {
      continue;
    }
    match runs.last_mut() {
      Some((start, text)) if *start + text.chars().count() == idx => {
        text.push(*ch);
      }
      _ => runs.push((idx, ch.to_string())),
    }
  }
  runs
    .into_iter()
    .filter(|(_, text)| !text.trim().is_empty())
    .map(|(start, text)| {
      let len = text.chars().count() as f64;
      (left + start as f64 * advance, len * advance, text)
    })
    .collect()
}

/// Page origin used to shift viewport-relative rects into absolute user space.
/// Falls back to the template page when the requested page has no entry.
fn origin_for(spec: &ExcludeRegions, page: u32) -> (f64, f64) {
  spec
    .pages
    .iter()
    .find(|p| p.page == page)
    .or_else(|| spec.pages.iter().find(|p| !p.rects.is_empty()))
    .map(|p| (p.page_x, p.page_y))
    .unwrap_or((0.0, 0.0))
}

/// Clamp rects to the page box, dropping the ones that fall entirely outside.
fn clamp_all(rects: &[RegionRect], page_width: f64, page_height: f64) -> Vec<RegionRect> {
  if page_width <= 0.0 || page_height <= 0.0 {
    return rects.to_vec();
  }
  rects
    .iter()
    .filter_map(|r| clamp_rect(r, page_width, page_height))
    .collect()
}

fn clamp_rect(r: &RegionRect, page_width: f64, page_height: f64) -> Option<RegionRect> {
  let x = r.x.clamp(0.0, page_width);
  let y = r.y.clamp(0.0, page_height);
  let width = (r.x + r.width).min(page_width) - x;
  let height = (r.y + r.height).min(page_height) - y;
  if width <= 0.0 || height <= 0.0 {
    return None;
  }
  Some(RegionRect {
    x,
    y,
    width,
    height,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use pdf_inspector::extractor::ItemType;

  fn rect(x: f64, y: f64, width: f64, height: f64) -> RegionRect {
    RegionRect {
      x,
      y,
      width,
      height,
    }
  }

  fn page(page: u32, rects: Vec<RegionRect>) -> crate::models::PageExclude {
    crate::models::PageExclude {
      page,
      rects,
      page_x: 0.0,
      page_y: 0.0,
      page_width: 595.0,
      page_height: 842.0,
    }
  }

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

  fn spec(pages: Vec<crate::models::PageExclude>, all: bool) -> ExcludeRegions {
    ExcludeRegions {
      pages,
      use_for_all_pages: Some(all),
      total_pages: Some(3),
    }
  }

  #[test]
  fn per_page_entry_wins_over_template() {
    let s = spec(
      vec![
        page(1, vec![rect(0.0, 700.0, 595.0, 100.0)]),
        page(2, vec![]),
      ],
      true,
    );
    assert_eq!(rects_for_page(&s, 1).len(), 1);
    // An explicit empty entry opts the page out of the template.
    assert!(rects_for_page(&s, 2).is_empty());
    // Pages without an entry fall back to the template.
    assert_eq!(rects_for_page(&s, 3).len(), 1);
  }

  #[test]
  fn apply_all_pages_requires_the_flag() {
    let s = spec(vec![page(1, vec![rect(0.0, 0.0, 10.0, 10.0)])], false);
    assert_eq!(rects_for_page(&s, 1).len(), 1);
    assert!(rects_for_page(&s, 2).is_empty());
  }

  #[test]
  fn rects_are_clamped_to_the_page_box() {
    // Half of the rect hangs off the right edge of a narrower page.
    let mut narrow = page(1, vec![rect(500.0, 0.0, 200.0, 50.0)]);
    narrow.page_width = 595.0;
    let s = spec(vec![narrow], false);
    let clamped = rects_for_page(&s, 1);
    assert_eq!(clamped.len(), 1);
    assert_eq!(clamped[0].x, 500.0);
    assert_eq!(clamped[0].width, 95.0);
  }

  #[test]
  fn fully_outside_rects_are_dropped() {
    let s = spec(vec![page(1, vec![rect(700.0, 0.0, 50.0, 50.0)])], false);
    assert!(rects_for_page(&s, 1).is_empty());
  }

  #[test]
  fn items_overlapping_a_rect_are_dropped() {
    let s = spec(vec![page(1, vec![rect(0.0, 700.0, 595.0, 142.0)])], false);
    let items = vec![
      item("header", 72.0, 780.0, 40.0, 12.0), // inside
      item("body", 72.0, 600.0, 40.0, 12.0),   // below
    ];
    let kept = filter_items(&items, &page_filters(&s, 1));
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].text, "body");
  }

  #[test]
  fn touching_edges_are_not_excluded() {
    // The item ends exactly where the rect begins: no overlap.
    let s = spec(vec![page(1, vec![rect(100.0, 700.0, 100.0, 100.0)])], false);
    let items = vec![item("left", 0.0, 700.0, 100.0, 12.0)];
    assert_eq!(filter_items(&items, &page_filters(&s, 1)).len(), 1);
  }

  #[test]
  fn page_origin_shifts_rects_into_user_space() {
    let mut p = page(1, vec![rect(0.0, 0.0, 100.0, 100.0)]);
    p.page_x = 20.0;
    p.page_y = 30.0;
    let s = spec(vec![p], false);
    let filters = page_filters(&s, 1);
    let rects = filters.get(&1).expect("page filter");
    assert_eq!(rects[0].x, 20.0);
    assert_eq!(rects[0].y, 30.0);
  }

  #[test]
  fn empty_spec_keeps_every_item() {
    let s = ExcludeRegions {
      pages: Vec::new(),
      use_for_all_pages: None,
      total_pages: None,
    };
    let items = vec![item("a", 0.0, 0.0, 10.0, 12.0)];
    assert_eq!(filter_items(&items, &page_filters(&s, 1)).len(), 1);
  }

  /// A whole row merged by pdf-inspector (`"Alice   28    Beijing"` as one
  /// item) must not vanish when a vertical band covers just the "28" column:
  /// the rest of the line is kept.
  #[test]
  fn column_band_splits_a_merged_row_instead_of_dropping_it() {
    let s = spec(
      vec![page(1, vec![rect(113.0, 0.0, 9.0, 842.0)])], // over the "28" token
      false,
    );
    let line = item("Alice   28    Beijing", 72.0, 770.0, 100.0, 12.0);
    let kept = filter_items(&[line], &page_filters(&s, 1));
    // The full-width item is split; the excluded token is gone, both sides keep.
    assert_eq!(kept.len(), 2);
    assert_eq!(kept[0].text.trim(), "Alice");
    assert_eq!(kept[1].text.trim(), "Beijing");
  }

  /// A full-width rect (header/footer band) still removes the whole line.
  #[test]
  fn full_width_band_removes_the_whole_line() {
    let s = spec(vec![page(1, vec![rect(0.0, 700.0, 595.0, 142.0)])], false);
    let line = item("header text", 72.0, 780.0, 100.0, 12.0);
    assert!(filter_items(&[line], &page_filters(&s, 1)).is_empty());
  }

  /// Split pieces keep their geometry so downstream line grouping is
  /// unaffected (same baseline, page, font).
  #[test]
  fn split_pieces_preserve_item_metadata() {
    // Band covering the middle gap chars (idx 2-3): "AB" and "CD" both survive.
    let s = spec(vec![page(1, vec![rect(120.0, 0.0, 20.0, 842.0)])], false);
    let line = item("AB  CD", 100.0, 770.0, 60.0, 12.0);
    let kept = filter_items(&[line.clone()], &page_filters(&s, 1));
    assert_eq!(kept.len(), 2);
    for piece in &kept {
      assert_eq!(piece.y, line.y);
      assert_eq!(piece.page, line.page);
      assert_eq!(piece.font_size, line.font_size);
      assert!(piece.width > 0.0);
    }
    assert_eq!(kept[0].text, "AB");
    assert_eq!(kept[0].x, 100.0);
    assert_eq!(kept[1].text, "CD");
    assert_eq!(kept[1].x, 140.0);
  }

  #[test]
  fn hits_box_uses_strict_overlap_on_every_edge() {
    let rects = vec![rect(100.0, 700.0, 100.0, 100.0)];
    // Contained.
    assert!(hits_box(&rects, 120.0, 720.0, 10.0, 10.0));
    // Straddling the right border.
    assert!(hits_box(&rects, 190.0, 720.0, 20.0, 10.0));
    // Ends exactly where the rect starts: touching is not overlapping.
    assert!(!hits_box(&rects, 80.0, 720.0, 20.0, 10.0));
    // Entirely above the rect.
    assert!(!hits_box(&rects, 120.0, 810.0, 10.0, 10.0));
  }

  #[test]
  fn split_box_outside_returns_the_whole_text_when_nothing_overlaps() {
    let far_away = vec![rect(0.0, 0.0, 10.0, 10.0)];
    let pieces = split_box_outside(&far_away, 100.0, 700.0, 40.0, 12.0, "hello");
    assert_eq!(pieces.len(), 1);
    assert_eq!(pieces[0], (100.0, 40.0, "hello".to_string()));
  }

  #[test]
  fn split_box_outside_drops_a_fully_covered_box() {
    let full = vec![rect(0.0, 0.0, 595.0, 842.0)];
    assert!(split_box_outside(&full, 72.0, 700.0, 100.0, 12.0, "header").is_empty());
  }

  /// The line-draw pipeline assigns content to columns by x, so every piece
  /// must keep the x it occupied in the source box: excluding a middle column
  /// must not shift the right-hand columns one slot to the left.
  #[test]
  fn split_box_outside_keeps_each_piece_at_its_original_x() {
    let band = vec![rect(113.0, 0.0, 9.0, 842.0)];
    let (left, width) = (72.0, 100.0);
    let pieces = split_box_outside(&band, left, 770.0, width, 12.0, "Alice   28    Beijing");
    assert_eq!(pieces.len(), 2);
    assert_eq!(pieces[0].2.trim(), "Alice");
    assert_eq!(
      pieces[0].0, left,
      "the leading piece starts where the line did"
    );
    assert_eq!(pieces[1].2.trim(), "Beijing");
    assert!(
      pieces[1].0 > left + width / 2.0,
      "the trailing piece must stay on the right, got x={}",
      pieces[1].0
    );
  }
}
