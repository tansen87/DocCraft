//! Paragraph line-break policy: join soft line breaks inside a paragraph while
//! keeping hard ones (paragraph boundaries, tables, lists, headings, code).
//!
//! Every channel of the PDF pipeline produces one Markdown line per visual
//! line - `grid_rebuild::lines_to_markdown` for text-layer pages, the OCR
//! engines for scanned pages. This module applies the user's
//! [`ParagraphMode`] as a **pure post-process** on the per-page markdown:
//!
//! * `Guided` - merge only inside the user-selected table columns (00015);
//!   with no selection it keeps one Markdown line per visual line (the
//!   removed `keep` behaviour, applied by the callers that carry the config).
//! * `Smart` - merge only soft line breaks: two consecutive visual lines are
//!   joined unless a geometric (text pages, [`LineMeta`]) or textual (OCR
//!   pages) signal marks a hard break between them.
//! * `None`  - merge every line of a page into one (tables and code fences
//!   are still kept as-is).
//!
//! Structural content is always protected: whole pages detected as GFM tables
//! or multi-column layouts are skipped, `|` table rows and ``` code fences are
//! never merged.
//!
//! The policy runs **after** the extraction cache (`extract_cache.rs`), so
//! switching it never re-decodes the PDF; the cache holds the canonical
//! line-per-visual-line form plus per-line geometry.

use crate::core::grid_rebuild::LineMeta;
use crate::models::ParagraphMode;

/// Apply the paragraph policy to every page of a document.
///
/// `meta` is the per-page line geometry from the extraction cache (parallel
/// to `pages`); `None` or empty entries fall back to the textual heuristics
/// (used for OCR-derived pages, which have no geometry).
pub fn apply(
  pages: &[String],
  meta: Option<&[Vec<LineMeta>]>,
  pages_with_tables: &[u32],
  pages_with_columns: &[u32],
  mode: ParagraphMode,
) -> Vec<String> {
  pages
    .iter()
    .enumerate()
    .map(|(i, md)| {
      let page_no = (i + 1) as u32;
      // G0-a / G0-b: table pages and multi-column pages must stay untouched -
      // joining rows would destroy a table, and joining lines would splice the
      // end of one column to the start of the next.
      if pages_with_tables.contains(&page_no)
        || pages_with_columns.contains(&page_no)
        || mode == ParagraphMode::Guided
      {
        return md.clone();
      }
      let page_meta = meta.and_then(|m| m.get(i)).map(|v| v.as_slice());
      join_page(md, page_meta, mode)
    })
    .collect()
}

/// Single-page helper for OCR results (no geometry available): runs the
/// textual heuristics. `Guided` returns the text unchanged - it needs the
/// column context (drawn vertical lines) that a bare string cannot carry, so
/// outside the image-table extractor it degrades to per-line (00015 §2.3).
pub fn apply_text(text: &str, mode: ParagraphMode) -> String {
  if mode == ParagraphMode::Guided {
    return text.to_string();
  }
  join_page(text, None, mode)
}

/// An indent at least this wide (in em) marks a **column position** rather
/// than a paragraph first-line indent. Chinese first-line indents are 2
/// characters (~2em) and English ones ~0.5in (~3em at 12pt), while column
/// gutters are always wider - so this separates a wrapped table cell (G8)
/// from the first line of a new paragraph (G2).
const COLUMN_INDENT_EM: f32 = 3.5;

/// Geometry summary of a page, estimated from its own lines so no page
/// dimensions are needed.
struct PageGeom {
  block_left: f32,
  text_width: f32,
  /// True when at least one line of the page is the wrapped remainder of a
  /// column (G8) - i.e. the page is a column / borderless-table layout. In
  /// such a page every flush-left line starts a new record (G9), so rows must
  /// not be joined into one another.
  column_layout: bool,
}

/// Join the visual lines of one page according to `mode`.
fn join_page(markdown: &str, meta: Option<&[LineMeta]>, mode: ParagraphMode) -> String {
  let lines: Vec<&str> = markdown.lines().collect();
  if lines.len() <= 1 {
    return markdown.to_string();
  }
  // G0-a: a page that is a GFM table must stay untouched - merging its rows
  // would destroy the table (and the Markdown > Excel export with it).
  if is_table_page(&lines) {
    return markdown.to_string();
  }

  let geom = meta.map(|m| {
    let block_left = m.iter().map(|l| l.x0).fold(f32::INFINITY, f32::min);
    let x1_max = m.iter().map(|l| l.x1).fold(f32::NEG_INFINITY, f32::max);
    // G8 pre-scan: one wrapped cell anywhere marks the page as a column
    // layout, which switches G9 on for every flush-left line of the page.
    let column_layout = m.windows(2).any(|pair| {
      let (prev, cur) = (&pair[0], &pair[1]);
      (cur.x0 - block_left) >= cur.font_size * COLUMN_INDENT_EM
        && cur.x0 <= prev.x1 + cur.font_size * 0.5
    });
    PageGeom {
      block_left,
      text_width: (x1_max - block_left).max(1.0),
      column_layout,
    }
  });

  let mut out: Vec<String> = Vec::with_capacity(lines.len());
  // Precompute the median line length once per page - it is identical for every
  // pair of lines, so recomputing it inside the loop would cost O(n² log n).
  let median = median_line_len(&lines);
  let mut fence = false;
  for (i, line) in lines.iter().enumerate() {
    let trimmed = line.trim();
    // GFM fences are recognised by their leading marker; toggling on the
    // trimmed line avoids false flips on code that merely contains "```".
    let cur_is_fence = is_fence_marker(trimmed);
    if cur_is_fence {
      fence = !fence;
    }
    let prev = out.last().map(|s| s.trim()).unwrap_or("");

    // Blank lines, code fences and `|` table rows are never merged with their
    // neighbours - they are structural boundaries (a blank line also means the
    // next line starts a fresh paragraph, never glued onto the blank).
    if out.is_empty()
      || trimmed.is_empty()
      || fence
      || prev.is_empty()
      || cur_is_fence
      || is_fence_marker(prev)
      || trimmed.starts_with('|')
      || prev.starts_with('|')
    {
      out.push(line.to_string());
      continue;
    }

    let hard = if mode == ParagraphMode::None {
      false
    } else if let (Some(m), Some(g)) = (meta, geom.as_ref()) {
      hard_break_geometric(prev, line, m, g, i, median)
    } else {
      hard_break_textual(prev, line, median)
    };

    if hard {
      out.push(line.to_string());
    } else {
      let joined = join_pieces(prev, line);
      out.pop();
      out.push(joined);
    }
  }
  out.join("\n")
}

/// Decide whether a hard break sits between line `i - 1` and line `i` using
/// the geometry captured at rebuild time (text-layer pages).
fn hard_break_geometric(
  prev: &str,
  cur: &str,
  meta: &[LineMeta],
  geom: &PageGeom,
  i: usize,
  median: usize,
) -> bool {
  let (Some(m_prev), Some(m_cur)) = (meta.get(i.wrapping_sub(1)), meta.get(i)) else {
    return hard_break_textual(prev, cur, median);
  };

  // G7 has priority: an English word split by a hyphen must be re-joined even
  // if the line spacing or font size jitters.
  if dehyphenatable(prev, cur) {
    return false;
  }

  let line_height = m_prev.font_size * 1.2;
  // G1: paragraph spacing. Regular line-to-line leading is ≈ line_height; a
  // gap of 1.5× or more means a new paragraph.
  if m_prev.y - m_cur.y > line_height * 1.5 {
    return true;
  }
  // G4: font size change (heading, footnote, caption).
  if (m_cur.font_size - m_prev.font_size).abs() > 0.5 {
    return true;
  }

  let indent_prev = m_prev.x0 - geom.block_left;
  let indent_cur = m_cur.x0 - geom.block_left;
  // G8: wrapped column content. The line starts at a column position - an
  // indent far wider than a first-line one - that the previous line already
  // reached horizontally. That means this line is the wrapped remainder of
  // that column (e.g. the second column of a borderless table whose text
  // wraps over several visual lines), so it must be joined back onto the
  // previous logical line. Without this check G2 below mistakes it for the
  // first line of a new paragraph and leaves every wrapped row separate.
  if indent_cur >= m_cur.font_size * COLUMN_INDENT_EM
    && m_cur.x0 <= m_prev.x1 + m_cur.font_size * 0.5
  {
    return false;
  }
  // G9: in a column layout a flush-left line starts a new record - the next
  // row of a borderless table. Two adjacent rows usually share the exact same
  // geometry, so without this the header row and all data rows would collapse
  // into one line. Only the current line has to be flush left: the line above
  // may be the wrapped tail of the previous record.
  if geom.column_layout && indent_cur < m_cur.font_size * 0.5 {
    return true;
  }
  // G2: first-line indent (a fresh paragraph starts indented, the previous
  // line was flush left). Indents wider than [`COLUMN_INDENT_EM`] are column
  // positions handled by G8 above, never a paragraph start.
  if indent_cur > m_cur.font_size * 1.5 && indent_prev < m_prev.font_size * 0.5 {
    return true;
  }
  // G3: the previous line ended short (right ragged edge) and the next line
  // starts flush left - the previous paragraph ended.
  if (m_prev.x1 - geom.block_left) < geom.text_width * 0.6 && indent_cur < m_cur.font_size * 0.5 {
    return true;
  }
  // G5: the current line opens a list item / numbered clause.
  starts_block_marker(cur)
}

/// Decide whether a hard break sits between `prev` and `cur` using only the
/// text itself (OCR pages have no geometry). `median` is the precomputed
/// median line length of the whole page, used for the short-line heuristic.
fn hard_break_textual(prev: &str, cur: &str, median: usize) -> bool {
  // T1: the previous line ends with sentence punctuation.
  if ends_sentence(prev) {
    return true;
  }
  // T2: the current line starts indented (≥2 half-width or ≥1 full-width).
  if cur.starts_with("  ") || cur.starts_with('\u{3000}') {
    return true;
  }
  // T3: the current line opens a list / numbered clause.
  if starts_block_marker(cur) {
    return true;
  }
  // T5: the previous line ends with a colon (introduces a list or sub-clause).
  let prev_trim = prev.trim_end();
  if prev_trim.ends_with(':') || prev_trim.ends_with('：') {
    return true;
  }
  // T4: the previous line is a short line (heading / caption), unless it
  // already ended a sentence (which T1 would have caught).
  if median > 0 && prev_trim.chars().count() * 2 < median {
    return true;
  }
  false
}

/// Join the fragments of one logical unit that was split over several visual
/// lines - the table-cell flavour of [`join_pieces`]. Used by the line-draw
/// table extractor, which already knows the fragments belong together and
/// therefore never needs the break/no-break heuristics.
///
/// Empty fragments are skipped, so a wrapped cell whose first line is blank
/// does not gain a leading space.
pub fn join_fragments(parts: &[&str]) -> String {
  let mut out = String::new();
  for part in parts {
    let p = part.trim();
    if p.is_empty() {
      continue;
    }
    if out.is_empty() {
      out.push_str(p);
    } else {
      out = join_pieces(&out, p);
    }
  }
  out
}

/// Join two soft-wrapped lines. De-hyphenates split English words
/// (`inter-` + `national` → `international`) and otherwise picks the right
/// connector: no space between CJK characters, one space elsewhere.
fn join_pieces(prev: &str, cur: &str) -> String {
  let p = prev.trim_end();
  let c = cur.trim_start();
  if dehyphenatable(prev, cur) {
    // prev ends with '-'; drop it and splice directly.
    let mut chars = p.chars();
    chars.next_back();
    format!("{}{}", chars.as_str(), c)
  } else {
    format!("{}{}{}", p, connector(p, c), c)
  }
}

/// `co-` + `operative` → merge without separator; CJK never takes a space.
fn connector(prev: &str, cur: &str) -> &'static str {
  match (prev.chars().next_back(), cur.chars().next()) {
    (Some(a), Some(b)) if is_cjk(a) && is_cjk(b) => "",
    _ => " ",
  }
}

/// Whether `prev` ends with a hyphen splitting an English word that `cur`
/// continues (lowercase letter on both sides of the break).
fn dehyphenatable(prev: &str, cur: &str) -> bool {
  let mut chars = prev.trim_end().chars().rev();
  if chars.next() != Some('-') {
    return false;
  }
  let before = chars.next();
  let after = cur.trim_start().chars().next();
  before.is_some_and(|ch| ch.is_ascii_alphabetic())
    && after.is_some_and(|ch| ch.is_ascii_lowercase())
}

/// A page whose lines form a GFM table: it has a `---` delimiter row, or the
/// majority of its lines are `|`-wrapped table rows. Such pages are left
/// untouched by every mode.
fn is_table_page(lines: &[&str]) -> bool {
  let has_delimiter = lines
    .iter()
    .any(|l| l.trim().starts_with('|') && l.contains("---"));
  if has_delimiter {
    return true;
  }
  let total = lines.len();
  if total == 0 {
    return false;
  }
  let rows = lines
    .iter()
    .filter(|l| {
      let t = l.trim();
      t.starts_with('|') && t.ends_with('|')
    })
    .count();
  rows * 2 >= total
}

/// Whether a line is a GFM fence marker (``` or ~~~). Both the opener and
/// the closer are structural boundaries: content after a closing fence must
/// never be glued onto it.
fn is_fence_marker(line: &str) -> bool {
  let t = line.trim();
  t.starts_with("```") || t.starts_with("~~~")
}

/// Whether a line opens a structural block: list item, numbered clause,
/// heading, quote or table row - never merged with the previous line.
fn starts_block_marker(line: &str) -> bool {
  let t = line.trim_start();
  let Some(first) = t.chars().next() else {
    return false;
  };
  // Markdown structure: heading, quote, table row, fence.
  if matches!(first, '#' | '>' | '|') {
    return true;
  }
  if t.starts_with("```") || t.starts_with("~~~") {
    return true;
  }
  // Unordered list markers and circled numbers.
  if matches!(
    first,
    '-' | '*' | '+' | '•' | '·' | '○' | '■' | '▪' | '●' | '◦'
  ) {
    return true;
  }
  if matches!(
    first,
    '①'
      | '②'
      | '③'
      | '④'
      | '⑤'
      | '⑥'
      | '⑦'
      | '⑧'
      | '⑨'
      | '⑩'
      | '⑪'
      | '⑫'
      | '⑬'
      | '⑭'
      | '⑮'
      | '⑴'
      | '⑵'
      | '⑶'
      | '⑷'
      | '⑸'
      | '⑹'
      | '⑺'
      | '⑻'
      | '⑼'
      | '⑽'
  ) {
    return true;
  }
  if first.is_ascii_digit() {
    let num_len = t.chars().take_while(|ch| ch.is_ascii_digit()).count();
    let rest = &t[num_len..];
    let after = rest.chars().next();
    // 1、  1)  1）  1:  are always markers; `1.` is a marker only when the dot
    // is followed by whitespace, so "1. 条款" is a clause but "1.1 背景" (a
    // version number) is not.
    match after {
      Some('.') => return rest[1..].chars().next().is_some_and(char::is_whitespace),
      Some('、') | Some(')') | Some('）') | Some(':') | Some('：') => return true,
      _ => {}
    }
  }
  // (1)  （1）
  if matches!(first, '(' | '（') {
    let rest = &t[first.len_utf8()..];
    let num_len = rest.chars().take_while(|ch| ch.is_ascii_digit()).count();
    if num_len > 0 {
      let after = rest[num_len..].chars().next();
      if matches!(after, Some(')') | Some('）')) {
        return true;
      }
    }
  }
  // 一、  （一） 第一章 / 第1条 / 第X节
  if is_cjk(first) {
    if t.starts_with('第') {
      if t
        .chars()
        .skip(1)
        .take(5)
        .any(|ch| matches!(ch, '章' | '条' | '节' | '款' | '项' | '部'))
      {
        return true;
      }
    } else if first != '第' {
      let after = t[first.len_utf8()..].chars().next();
      if matches!(after, Some('、') | Some('.') | Some('．') | Some('）')) {
        return true;
      }
    }
  }
  // Latin lettered list:  A. followed by whitespace. A dot NOT followed by
  // whitespace is an abbreviation, initial or name ("U.S. policy", "J. Smith")
  // and must not split a paragraph.
  if first.is_ascii_alphabetic() {
    let after = t[1..].chars().next();
    if after == Some('.') {
      return t[2..].chars().next().is_some_and(char::is_whitespace);
    }
  }
  false
}

/// Whether a line ends a sentence - a strong paragraph boundary. Only *strong*
/// enders (sentence punctuation, and the Japanese close quotes `」` `』` that
/// in Chinese text almost always close a sentence) count; parentheses, ASCII
/// quotes and apostrophes are only *possible* boundaries and must not split a
/// paragraph (e.g. "(详见附录一)" or "J. Smith's").
fn ends_sentence(line: &str) -> bool {
  let Some(last) = line.trim_end().chars().next_back() else {
    return false;
  };
  matches!(
    last,
    '.' | '。' | '！' | '？' | '…' | '；' | ';' | '!' | '?' | '」' | '』'
  )
}

/// Median character length of the non-empty lines, used by the short-line
/// (heading / caption) heuristic.
fn median_line_len(lines: &[&str]) -> usize {
  let mut lens: Vec<usize> = lines
    .iter()
    .filter(|l| !l.trim().is_empty())
    .map(|l| l.trim().chars().count())
    .collect();
  if lens.is_empty() {
    return 0;
  }
  lens.sort_unstable();
  lens[lens.len() / 2]
}

/// Normalize raw local OCR output before the paragraph policy runs
/// (docs/design/00017 P1-1):
/// 1. strip zero-width characters and the BOM;
/// 2. collapse in-line whitespace runs (incl. the full-width U+3000) to a
///    single ASCII space;
/// 3. insert exactly one space at every direct CJK ↔ Latin/digit boundary,
///    aligning with `connector` but applied within a line.
///
/// Newlines are preserved so the per-line paragraph heuristics still see the
/// original line structure; punctuation width is left untouched.
pub fn clean_ocr_text(input: &str) -> String {
  input
    .lines()
    .map(collapse_whitespace_and_zero_width)
    .map(|line| normalize_cjk_spacing(&line))
    .collect::<Vec<_>>()
    .join("\n")
}

/// Drop zero-width / BOM control characters and collapse each whitespace run
/// (incl. full-width) to a single ASCII space.
fn collapse_whitespace_and_zero_width(line: &str) -> String {
  let mut out = String::new();
  let mut in_ws = false;
  for c in line.chars() {
    if matches!(
      c,
      '\u{feff}' | '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{2060}'
    ) {
      continue;
    }
    if c.is_whitespace() {
      if !in_ws {
        out.push(' ');
        in_ws = true;
      }
    } else {
      out.push(c);
      in_ws = false;
    }
  }
  out
}

/// Insert exactly one space at every CJK ⟷ Latin/digit boundary. Existing
/// spaces (collapsed to one) are left as-is - a separator already present
/// stops the boundary test from inserting a duplicate.
fn normalize_cjk_spacing(line: &str) -> String {
  let mut out = String::new();
  for c in line.chars() {
    let cur_cjk = is_cjk(c);
    let cur_latin = c.is_ascii_alphanumeric();
    if let Some(prev) = out.chars().next_back() {
      if !c.is_whitespace()
        && !prev.is_whitespace()
        && ((is_cjk(prev) && cur_latin) || (cur_cjk && prev.is_ascii_alphanumeric()))
      {
        out.push(' ');
      }
    }
    out.push(c);
  }
  out
}

/// CJK ideographs, kana, hangul and CJK punctuation (U+3000–303F, U+FF00–FF60)
/// are joined without a space; other scripts take a single space.
pub fn is_cjk(c: char) -> bool {
  matches!(c as u32,
    0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF
      | 0x3040..=0x30FF | 0xAC00..=0xD7AF
      | 0x3000..=0x303F | 0xFF00..=0xFF60)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn lm(y: f32, font_size: f32, x0: f32, x1: f32) -> LineMeta {
    LineMeta {
      y,
      font_size,
      x0,
      x1,
    }
  }

  /// Three wrapped lines of one Chinese paragraph: same font, regular leading,
  /// flush left. `Smart` must join them with no spaces.
  #[test]
  fn smart_joins_cjk_wrapped_paragraph_without_spaces() {
    let pages = vec!["第一行内容。\n第二行内容。\n第三行内容。".to_string()];
    let meta = vec![vec![
      lm(800.0, 12.0, 72.0, 520.0),
      lm(786.0, 12.0, 72.0, 520.0),
      lm(772.0, 12.0, 72.0, 520.0),
    ]];
    let out = apply(&pages, Some(&meta), &[], &[], ParagraphMode::Smart);
    assert_eq!(out[0], "第一行内容。第二行内容。第三行内容。");
  }

  /// English wrapped lines get a space; a hyphenated split word is de-hyphenated.
  #[test]
  fn smart_joins_latin_with_space_and_dehyphenates() {
    let pages = vec!["This is the first\ninter-\nnational standard.".to_string()];
    let meta = vec![vec![
      lm(800.0, 12.0, 72.0, 500.0),
      lm(786.0, 12.0, 72.0, 400.0),
      lm(772.0, 12.0, 72.0, 500.0),
    ]];
    let out = apply(&pages, Some(&meta), &[], &[], ParagraphMode::Smart);
    assert_eq!(out[0], "This is the first international standard.");
  }

  /// A paragraph gap (G1) is a hard break: the second paragraph stays on its
  /// own line.
  #[test]
  fn smart_keeps_paragraph_gap() {
    let pages = vec!["第一段第一行\n第一段第二行\n\n第二段内容".to_string()];
    let meta = vec![vec![
      lm(800.0, 12.0, 72.0, 500.0),
      lm(786.0, 12.0, 72.0, 500.0),
      lm(756.0, 12.0, 72.0, 500.0),
    ]];
    let out = apply(&pages, Some(&meta), &[], &[], ParagraphMode::Smart);
    assert_eq!(out[0], "第一段第一行第一段第二行\n\n第二段内容");
  }

  /// First-line indent (G2) starts a new paragraph.
  #[test]
  fn smart_keeps_first_line_indent() {
    let pages = vec!["上一段结尾\n    这是一个缩进的新段落。".to_string()];
    let meta = vec![vec![
      lm(800.0, 12.0, 72.0, 500.0),
      lm(786.0, 12.0, 96.0, 500.0), // x0 indented by 24pt = 2 × 12pt font
    ]];
    let out = apply(&pages, Some(&meta), &[], &[], ParagraphMode::Smart);
    assert_eq!(out[0], "上一段结尾\n    这是一个缩进的新段落。");
  }

  /// GFM table pages are never touched, in any mode.
  #[test]
  fn table_page_is_untouched_in_all_modes() {
    let table = "| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 28 |";
    for mode in [ParagraphMode::Smart, ParagraphMode::None] {
      let out = apply(&[table.to_string()], None, &[], &[], mode);
      assert_eq!(out[0], table);
    }
  }

  /// Multi-column pages keep their line breaks (reading order).
  #[test]
  fn multi_column_page_keeps_lines() {
    let pages = vec!["col one line\ncol two line".to_string()];
    let out = apply(&pages, None, &[], &[1], ParagraphMode::Smart);
    assert_eq!(out[0], "col one line\ncol two line");
  }

  /// List items and numbered clauses are never merged with the previous line.
  #[test]
  fn list_items_are_kept() {
    let pages = vec!["正文一行内容\n1. 第一条款内容\n2. 第二条款内容".to_string()];
    let out = apply(&pages, None, &[], &[], ParagraphMode::Smart);
    assert_eq!(out[0], "正文一行内容\n1. 第一条款内容\n2. 第二条款内容");
  }

  /// Code fences protect their content from merging.
  #[test]
  fn code_fence_is_kept() {
    let pages = vec!["前一行\n```\nlet x = 1\nlet y = 2\n```\n后一行".to_string()];
    let out = apply(&pages, None, &[], &[], ParagraphMode::Smart);
    assert_eq!(out[0], "前一行\n```\nlet x = 1\nlet y = 2\n```\n后一行");
  }

  /// Lines ending in closers / quotes / apostrophes are not sentence ends, so
  /// the following line is merged (P0-2); true sentence punctuation still
  /// breaks.
  #[test]
  fn closers_and_quotes_do_not_split_paragraphs() {
    let out = apply_text("(详见附录一)\n这是同一段的下一行。", ParagraphMode::Smart);
    assert_eq!(out, "(详见附录一) 这是同一段的下一行。");

    let out = apply_text("It is John's\nbook, page one.", ParagraphMode::Smart);
    assert_eq!(out, "It is John's book, page one.");

    let pages = vec!["第一段结尾。\n第二段开始。".to_string()];
    let out = apply(&pages, None, &[], &[], ParagraphMode::Smart);
    assert_eq!(out[0], "第一段结尾。\n第二段开始。");
  }

  /// A letter / digit list marker only splits when the dot is followed by
  /// whitespace: "A." is a list item, but "U.S." / "J. Smith" / "1.1" are not
  /// (P0-5).
  #[test]
  fn block_marker_dot_requires_whitespace() {
    assert!(starts_block_marker("A. first item"));
    assert!(starts_block_marker("1. 条款"));
    assert!(!starts_block_marker("U.S. policy on trade"));
    assert!(!starts_block_marker("1.1 背景"));

    let pages = vec!["U.S. policy on trade\nis consistent worldwide.".to_string()];
    let out = apply(&pages, None, &[], &[], ParagraphMode::Smart);
    assert_eq!(out[0], "U.S. policy on trade is consistent worldwide.");
  }

  /// OCR text heuristic: a sentence-ending line starts a new paragraph, and
  /// inside-paragraph lines merge.
  #[test]
  fn textual_heuristic_merges_ocr_paragraphs() {
    let pages =
      vec!["这是一个段落的第一行\n继续第二行。\n这是新的一段第一行\n继续新段第二行。".to_string()];
    let out = apply(&pages, None, &[], &[], ParagraphMode::Smart);
    assert_eq!(
      out[0],
      "这是一个段落的第一行继续第二行。\n这是新的一段第一行继续新段第二行。"
    );
  }

  /// `Guided` (no column config here) must be byte-identical - the removed
  /// `keep` behaviour; `None` merges everything but tables/fences.
  #[test]
  fn guided_is_identity_and_none_merges_all() {
    let src = "第一行\n第二行\n第三行";
    let out = apply(&[src.to_string()], None, &[], &[], ParagraphMode::Guided);
    assert_eq!(out[0], src);

    let out = apply(&[src.to_string()], None, &[], &[], ParagraphMode::None);
    assert_eq!(out[0], "第一行第二行第三行");
  }

  /// A single-column line is a strong break signal in textual mode.
  #[test]
  fn short_line_keeps_break() {
    let pages = vec!["Intro\n这是一段较长内容的开头,继续写下去继续写下去继续写下去".to_string()];
    let out = apply(&pages, None, &[], &[], ParagraphMode::Smart);
    assert_eq!(
      out[0],
      "Intro\n这是一段较长内容的开头,继续写下去继续写下去继续写下去"
    );
  }

  /// A two-column (borderless table) layout whose second column wraps over
  /// several visual lines. The wrapped remainder sits at the column's x, far
  /// indented from the block edge: it belongs to the cell above it and must
  /// be joined there - G2 alone would read it as a new paragraph and leave
  /// `smart` behaving exactly like `keep`.
  #[test]
  fn smart_joins_wrapped_column_content() {
    let pages = vec!["idx,desc\n1,this\nis\ntest".to_string()];
    let meta = vec![vec![
      lm(800.0, 12.0, 100.0, 340.0), // header row
      lm(786.0, 12.0, 100.0, 340.0), // "1" in col 1, "this" in col 2 (x=300)
      lm(772.0, 12.0, 300.0, 315.0), // "is"   - wrapped remainder of col 2
      lm(758.0, 12.0, 300.0, 340.0), // "test" - wrapped remainder of col 2
    ]];
    let out = apply(&pages, Some(&meta), &[], &[], ParagraphMode::Smart);
    assert_eq!(out[0], "idx,desc\n1,this is test");
  }

  /// Two records of a borderless table: every flush-left line starts a new
  /// record (G9) and each record's wrapped second column is joined onto its
  /// own record (G8), so records never bleed into one another.
  #[test]
  fn smart_keeps_record_rows_apart_in_column_layout() {
    let pages = vec!["1,this is\ntail one\n2,this is\ntail two".to_string()];
    let meta = vec![vec![
      lm(800.0, 12.0, 100.0, 340.0), // "1" + "this is"
      lm(786.0, 12.0, 300.0, 340.0), // "tail one" - wrapped tail of col 2
      lm(772.0, 12.0, 100.0, 340.0), // "2" + "this is" - new record
      lm(758.0, 12.0, 300.0, 340.0), // "tail two" - wrapped tail of col 2
    ]];
    let out = apply(&pages, Some(&meta), &[], &[], ParagraphMode::Smart);
    assert_eq!(out[0], "1,this is tail one\n2,this is tail two");
  }

  /// A plain paragraph page has no wrapped column, so G9 must stay off and
  /// its flush-left lines still merge as one paragraph.
  #[test]
  fn paragraph_page_without_columns_still_merges() {
    let pages = vec!["第一行内容\n第二行内容\n第三行内容".to_string()];
    let meta = vec![vec![
      lm(800.0, 12.0, 100.0, 340.0),
      lm(786.0, 12.0, 100.0, 340.0),
      lm(772.0, 12.0, 100.0, 340.0),
    ]];
    let out = apply(&pages, Some(&meta), &[], &[], ParagraphMode::Smart);
    assert_eq!(out[0], "第一行内容第二行内容第三行内容");
  }

  /// A far indented line whose x the previous line never reached is not the
  /// wrapped remainder of a column, so G8 must not fire on it.
  #[test]
  fn far_indent_beyond_previous_line_is_not_a_column_continuation() {
    let pages = vec!["左侧短行\n右侧另起内容".to_string()];
    let meta = vec![vec![
      lm(800.0, 12.0, 100.0, 150.0), // short line, ends well before x=400
      lm(786.0, 12.0, 400.0, 520.0), // far indented, no column above it
    ]];
    let out = apply(&pages, Some(&meta), &[], &[], ParagraphMode::Smart);
    assert_eq!(out[0], "左侧短行\n右侧另起内容");
  }

  /// Unknown / legacy config values (incl. the removed `"keep"`) fall back to
  /// `Guided` via the TryFrom mapping - same per-line behaviour as before.
  #[test]
  fn unknown_mode_string_falls_back_to_guided() {
    assert_eq!(
      ParagraphMode::try_from("weird".to_string()).unwrap(),
      ParagraphMode::Guided
    );
    assert_eq!(
      ParagraphMode::try_from("keep".to_string()).unwrap(),
      ParagraphMode::Guided
    );
    assert_eq!(
      ParagraphMode::try_from("smart".to_string()).unwrap(),
      ParagraphMode::Smart
    );
    assert_eq!(
      ParagraphMode::try_from("NONE".to_string()).unwrap(),
      ParagraphMode::None
    );
  }

  /// P1-1: `clean_ocr_text` strips zero-width / BOM characters, collapses
  /// in-line whitespace runs (incl. full-width) to one space, keeps newlines,
  /// and adds a space at CJK ⟷ Latin boundaries - but leaves plain text alone.
  #[test]
  fn clean_ocr_text_normalizes_noisy_local_output() {
    let out = clean_ocr_text("日期\u{feff}  \u{200b}  2026\u{3000}年\u{200b}\n第二\u{3000}行");
    assert_eq!(out, "日期 2026 年\n第二 行");

    assert_eq!(clean_ocr_text("中A"), "中 A");
    assert_eq!(clean_ocr_text("hello world"), "hello world");
  }

  /// P1-4: local OCR `off` mode supplies per-line geometry (y already flipped
  /// to PDF space). G1 uses it to detect a real paragraph gap while plain close
  /// lines of one paragraph merge - even when the textual heuristics would have
  /// treated the short lines as headings.
  #[test]
  fn ocr_geometry_detects_paragraph_vs_soft_break() {
    fn m(top: f32, h: f32) -> LineMeta {
      LineMeta {
        y: -top,
        font_size: h,
        x0: 90.0,
        x1: 400.0,
      }
    }
    // Soft break: two close flush-left lines of one paragraph → merged.
    let pages = vec!["这是一段较长的第一行内容\n这是同一段的第二行内容".to_string()];
    let meta = vec![vec![m(120.0, 20.0), m(145.0, 20.0)]];
    let out = apply(&pages, Some(&meta), &[], &[], ParagraphMode::Smart);
    assert_eq!(out[0], "这是一段较长的第一行内容这是同一段的第二行内容");

    // Paragraph gap (G1): far apart lines → hard break.
    let pages = vec!["第一段较长的第一行内容\n第二段较长的第二行内容".to_string()];
    let meta = vec![vec![m(120.0, 20.0), m(200.0, 20.0)]];
    let out = apply(&pages, Some(&meta), &[], &[], ParagraphMode::Smart);
    assert_eq!(out[0], "第一段较长的第一行内容\n第二段较长的第二行内容");
  }
}
