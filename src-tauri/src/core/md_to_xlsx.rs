use std::time::Instant;

use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Workbook, Worksheet};

use crate::core::page_marker::page_from_line;
use crate::models::{MdAnalyzeResult, MdExportResult, MdTable};

/// A block of Markdown content: either a GFM table or a plain text line.
enum MdBlock {
  Table(MdTable),
  Line(String),
}

/// A line is a GFM table delimiter when it only contains `-`, `:`, `|` and
/// spaces between the surrounding pipes, e.g. `| --- | :---: | --------- |`.
fn is_delimiter(line: &str) -> bool {
  let s = line.trim();
  if !s.starts_with('|') || !s.ends_with('|') {
    return false;
  }
  let inner = &s[1..s.len() - 1];
  inner.chars().all(|c| matches!(c, '-' | ':' | '|' | ' ')) && inner.contains('-')
}

/// Split a GFM table row into cells. Bare pipes are escaped with `\|`.
fn split_cells(line: &str) -> Vec<String> {
  let mut s = line.trim();
  if s.starts_with('|') {
    s = &s[1..];
  }
  if s.ends_with('|') {
    s = &s[..s.len() - 1];
  }
  let chars: Vec<char> = s.chars().collect();
  let mut cells = Vec::new();
  let mut current = String::new();
  let mut i = 0;
  while i < chars.len() {
    let c = chars[i];
    if c == '\\' && i + 1 < chars.len() && chars[i + 1] == '|' {
      current.push('|');
      i += 1;
    } else if c == '|' {
      cells.push(current.trim().to_string());
      current.clear();
    } else {
      current.push(c);
    }
    i += 1;
  }
  cells.push(current.trim().to_string());
  cells
}

/// Whether a line is a GFM code fence (``` or ~~~), toggling it on the
/// trimmed line avoids false flips on code that merely contains "```".
fn is_fence_marker(line: &str) -> bool {
  let t = line.trim();
  t.starts_with("```") || t.starts_with("~~~")
}

/// Split a Markdown document into ordered blocks: GFM tables and plain text
/// lines. Tables that follow a `<!-- Page N -->` marker are tagged with that
/// source page; the marker persists across following blocks. Lines inside a
/// code fence are always emitted as plain lines - the GFM table sample inside
/// them is documentation, not a real table to export.
fn parse_md_blocks(content: &str) -> Vec<MdBlock> {
  let lines: Vec<&str> = content.lines().collect();
  let mut blocks = Vec::new();
  let mut current_page: Option<u32> = None;
  let mut fence = false;
  let mut i = 0usize;
  while i < lines.len() {
    let raw = lines[i];
    let line = raw.trim();
    // Fences are recognised before table detection: after toggling, every line
    // inside (opener, body, closer) is a plain text line.
    let cur_is_fence = is_fence_marker(line);
    if cur_is_fence {
      fence = !fence;
    }
    if fence {
      blocks.push(MdBlock::Line(raw.to_string()));
      i += 1;
      continue;
    }
    if let Some(page) = page_from_line(line) {
      current_page = Some(page);
      i += 1;
      continue;
    }
    let header = line;
    let delim = lines.get(i + 1).map(|l| l.trim()).unwrap_or("");
    if header.starts_with('|') && is_delimiter(delim) {
      let columns = split_cells(header);
      let ncols = columns.len().max(1);
      let mut rows = Vec::new();
      let mut j = i + 2;
      while j < lines.len() {
        let row = lines[j].trim();
        if row.is_empty() || !row.starts_with('|') {
          break;
        }
        let cells = split_cells(row);
        let padded: Vec<String> = (0..ncols)
          .map(|k| cells.get(k).cloned().unwrap_or_default())
          .collect();
        rows.push(padded);
        j += 1;
      }
      blocks.push(MdBlock::Table(MdTable {
        columns,
        rows,
        page: current_page,
      }));
      i = j;
    } else {
      if !line.is_empty() {
        blocks.push(MdBlock::Line(line.to_string()));
      }
      i += 1;
    }
  }
  blocks
}

/// Extract every GitHub-Flavored Markdown table from a document. Tables that
/// follow a `<!-- Page N -->` marker are tagged with that source page.
pub fn parse_md_tables(content: &str) -> Vec<MdTable> {
  parse_md_blocks(content)
    .into_iter()
    .filter_map(|block| match block {
      MdBlock::Table(table) => Some(table),
      MdBlock::Line(_) => None,
    })
    .collect()
}

fn read_file(path: &str) -> Result<String, String> {
  std::fs::read_to_string(path).map_err(|e| format!("Fail to read file: {e}"))
}

/// Analyze a Markdown file and return every table it contains (for preview),
/// together with the raw file content so the frontend can render the markdown
/// without a second read of the file.
pub fn analyze_markdown(path: &str) -> Result<MdAnalyzeResult, String> {
  let content = read_file(path)?;
  let start = Instant::now();
  let tables = parse_md_tables(&content);
  let total_rows = tables.iter().map(|t| t.rows.len()).sum::<usize>();
  Ok(MdAnalyzeResult {
    table_count: tables.len(),
    tables,
    total_rows,
    total_lines: content.lines().count(),
    processing_time_ms: start.elapsed().as_millis() as u64,
    content,
  })
}

/// One numeric cell value. `Percent` keeps the fraction so the writer can
/// apply a percentage number format that renders `12%`.
#[derive(Debug, Clone, Copy, PartialEq)]
enum NumberCell {
  Num(f64),
  Percent(f64),
}

/// Conservative number sniffer (docs/design/00017 P1-3): only bare integers,
/// decimal numbers and percentages are written as numbers. Leading zeros
/// (`"0012"`), thousand separators (`"1,234.5"`) and long ID numbers stay text
/// because turning them into a number would lose their meaning.
fn sniff_number(s: &str) -> Option<NumberCell> {
  let t = s.trim();
  let (base, is_percent) = match t.strip_suffix('%') {
    Some(b) => (b, true),
    None => (t, false),
  };
  if base.is_empty() || !base.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
    return None;
  }
  // Keep "0" / "0.5", but drop other leading-zero strings like "0012".
  if base.len() > 1 && base.starts_with('0') && !base.starts_with("0.") {
    return None;
  }
  // At most one decimal point.
  if base.matches('.').count() > 1 {
    return None;
  }
  let value: f64 = base.parse().ok()?;
  Some(if is_percent {
    NumberCell::Percent(value / 100.0)
  } else {
    NumberCell::Num(value)
  })
}

/// Replace `[label](url)` links with `label`, keeping the visible text.
fn strip_links(s: &str) -> String {
  let chars: Vec<char> = s.chars().collect();
  let mut out = String::with_capacity(chars.len());
  let mut cursor = 0usize;
  while cursor < chars.len() {
    if chars[cursor] == '['
      && let Some(rel_b) = chars[cursor + 1..].iter().position(|&c| c == ']')
    {
      let close_b = cursor + 1 + rel_b;
      if chars.get(close_b + 1) == Some(&'(') {
        if let Some(rel_p) = chars[close_b + 2..].iter().position(|&c| c == ')') {
          // A well-formed link: keep the label, skip past the URL.
          out.extend(chars[cursor + 1..close_b].iter());
          cursor = close_b + 2 + rel_p + 1;
          continue;
        }
      }
    }
    out.push(chars[cursor]);
    cursor += 1;
  }
  out
}

/// Strip inline Markdown syntax before a value is written to Excel
/// (docs/design/00017 P1-2): remove `**` / `__` / `*` / backtick emphasis and
/// collapse `[text](url)` to `text`, and turn `<br>` into a newline. Plain text
/// passes through unchanged.
pub fn strip_inline_markdown(input: &str) -> String {
  let s = input
    .replace("<br>", "\n")
    .replace("<br/>", "\n")
    .replace("<br />", "\n");
  let s = strip_links(&s);
  s.replace("**", "")
    .replace("__", "")
    .replace('`', "")
    .replace('*', "")
}

/// Write one table cell, honoring the P1-3 numeric-cell and P1-2 Markdown
/// stripping flags.
fn write_cell(
  ws: &mut Worksheet,
  row: u32,
  col: u16,
  value: &str,
  strip_md: bool,
  write_numeric: bool,
  cell_fmt: &Format,
  num_fmt: &Format,
  percent_fmt: &Format,
) -> Result<(), String> {
  let shown = if strip_md {
    strip_inline_markdown(value)
  } else {
    value.to_string()
  };
  if write_numeric {
    if let Some(nc) = sniff_number(&shown) {
      let (v, fmt) = match nc {
        NumberCell::Num(v) => (v, num_fmt),
        NumberCell::Percent(v) => (v, percent_fmt),
      };
      ws.write_number_with_format(row, col, v, fmt)
        .map_err(|e| e.to_string())?;
      return Ok(());
    }
  }
  ws.write_string_with_format(row, col, &shown, cell_fmt)
    .map_err(|e| e.to_string())?;
  Ok(())
}

/// Write one table block (label row + header row + data rows + blank row) at
/// the current `row`, advancing it afterwards.
fn write_table(
  ws: &mut Worksheet,
  table: &MdTable,
  idx: usize,
  row: &mut u32,
  total_rows: &mut usize,
  header_fmt: &Format,
  cell_fmt: &Format,
  label_fmt: &Format,
  num_fmt: &Format,
  percent_fmt: &Format,
  strip_md: bool,
  write_numeric: bool,
) -> Result<(), String> {
  let label = match table.page {
    Some(page) => format!("Page {page}"),
    None => format!("Table {}", idx + 1),
  };
  ws.write_string_with_format(*row, 0, &label, label_fmt)
    .map_err(|e| e.to_string())?;
  *row += 1;
  for (col, name) in table.columns.iter().enumerate() {
    ws.write_string_with_format(*row, col as u16, name, header_fmt)
      .map_err(|e| e.to_string())?;
  }
  *row += 1;
  for r in &table.rows {
    for (col, value) in r.iter().enumerate() {
      write_cell(
        ws,
        *row,
        col as u16,
        value,
        strip_md,
        write_numeric,
        cell_fmt,
        num_fmt,
        percent_fmt,
      )?;
    }
    *row += 1;
    *total_rows += 1;
  }
  *row += 1;
  Ok(())
}

/// Parse the Markdown file at `md_path` and write it into the workbook at
/// `xlsx_path`. When `tables_only` is `true` only the GFM tables are exported;
/// otherwise the whole document (tables and plain text lines, in order) is
/// written into a single worksheet. `strip_md` enables inline Markdown
/// stripping (P1-2); `write_numeric` writes number-shaped cells as numeric when
/// `true` and keeps everything a string when `false` (P1-3).
pub fn export_markdown_tables(
  md_path: &str,
  xlsx_path: &str,
  tables_only: bool,
  strip_md: bool,
  write_numeric: bool,
) -> Result<MdExportResult, String> {
  let content = read_file(md_path)?;
  let start = Instant::now();

  let mut workbook = Workbook::new();
  let mut ws = workbook.add_worksheet();

  let header_fmt = Format::new()
    .set_bold()
    .set_border(FormatBorder::Thin)
    .set_background_color("E7EEF7")
    .set_align(FormatAlign::Center);
  let cell_fmt = Format::new().set_border(FormatBorder::Thin);
  let label_fmt = Format::new()
    .set_bold()
    .set_font_size(12)
    .set_align(FormatAlign::Left);
  let num_fmt = Format::new()
    .set_border(FormatBorder::Thin)
    .set_align(FormatAlign::Right);
  let percent_fmt = Format::new()
    .set_border(FormatBorder::Thin)
    .set_num_format("0.00%")
    .set_align(FormatAlign::Right);

  let mut row: u32 = 0;
  let mut total_rows = 0usize;
  let mut table_count = 0usize;

  if tables_only {
    let tables = parse_md_tables(&content);
    if tables.is_empty() {
      return Err("Table not found in Markdown".to_string());
    }
    for (idx, table) in tables.iter().enumerate() {
      write_table(
        &mut ws,
        table,
        idx,
        &mut row,
        &mut total_rows,
        &header_fmt,
        &cell_fmt,
        &label_fmt,
        &num_fmt,
        &percent_fmt,
        strip_md,
        write_numeric,
      )?;
    }
    table_count = tables.len();
  } else {
    let blocks = parse_md_blocks(&content);
    if blocks.is_empty() {
      return Err("No content found in Markdown".to_string());
    }
    for block in &blocks {
      match block {
        MdBlock::Table(table) => {
          write_table(
            &mut ws,
            table,
            table_count,
            &mut row,
            &mut total_rows,
            &header_fmt,
            &cell_fmt,
            &label_fmt,
            &num_fmt,
            &percent_fmt,
            strip_md,
            write_numeric,
          )?;
          table_count += 1;
        }
        MdBlock::Line(text) => {
          let line = if strip_md {
            strip_inline_markdown(text)
          } else {
            text.clone()
          };
          ws.write_string_with_format(row, 0, &line, &cell_fmt)
            .map_err(|e| e.to_string())?;
          row += 1;
          total_rows += 1;
        }
      }
    }
  }

  ws.autofit();
  workbook.save(xlsx_path).map_err(|e| e.to_string())?;

  Ok(MdExportResult {
    table_count,
    total_rows,
    processing_time_ms: start.elapsed().as_millis() as u64,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_single_gfm_table() {
    let md = "| Col A | Col B |\n|-------|-------|\n| 1     | x     |\n| 2     | y     |\n";
    let tables = parse_md_tables(md);
    assert_eq!(tables.len(), 1);
    assert_eq!(tables[0].columns, vec!["Col A", "Col B"]);
    assert_eq!(tables[0].rows.len(), 2);
    assert_eq!(tables[0].rows[0], vec!["1", "x"]);
    assert_eq!(tables[0].rows[1], vec!["2", "y"]);
  }

  #[test]
  fn ignores_tables_inside_code_fences() {
    let md = "intro\n\n```md\n| A | B |\n|---|---|\n| sample | table |\n```\n\n| Real | Column |\n|------|--------|\n| 1    | x      |\n";
    let tables = parse_md_tables(md);
    assert_eq!(tables.len(), 1);
    assert_eq!(tables[0].columns, vec!["Real", "Column"]);
    assert_eq!(tables[0].rows[0], vec!["1", "x"]);
  }

  #[test]
  fn ignores_tables_inside_tilde_fences() {
    let md = "before\n\n~~~\n| A | B |\n|---|---|\n| 1 | 2 |\n~~~\n\nafter";
    let tables = parse_md_tables(md);
    assert!(tables.is_empty());
  }

  #[test]
  fn parses_tables_around_plain_text() {
    let md = "intro text\n\n| H1 |\n|---|\n| a |\n\nsome paragraph\n\n| H1 | H2 | H3 |\n|:---|:---:|---:|\n| 1  | 2  | 3  |\n";
    let tables = parse_md_tables(md);
    assert_eq!(tables.len(), 2);
    assert_eq!(tables[0].columns, vec!["H1"]);
    assert_eq!(tables[1].columns, vec!["H1", "H2", "H3"]);
    assert_eq!(tables[1].rows[0], vec!["1", "2", "3"]);
  }

  #[test]
  fn handles_escaped_pipes_and_short_rows() {
    let md = "| A | B |\n|---|---|\n| a\\|b |\n";
    let tables = parse_md_tables(md);
    assert_eq!(tables[0].rows[0], vec!["a|b", ""]);
  }

  #[test]
  fn ignores_lines_without_delimiter() {
    let md = "| A | B |\n| 1 | 2 |\n";
    assert!(parse_md_tables(md).is_empty());
  }

  #[test]
  fn tracks_source_page_from_markers() {
    let md = "<!-- Page 1 -->\n\nintro\n\n| H1 |\n|---|\n| a |\n\n<!-- Page 3 -->\n\n| H1 | H2 |\n|----|----|\n| b  | c  |\n";
    let tables = parse_md_tables(md);
    assert_eq!(tables.len(), 2);
    assert_eq!(tables[0].page, Some(1));
    assert_eq!(tables[1].page, Some(3));
  }

  #[test]
  fn legacy_chinese_markers_still_attribute_pages() {
    let md = "<!-- 第 2 页 -->\n\n| A |\n|---|\n| a |\n";
    let tables = parse_md_tables(md);
    assert_eq!(tables.len(), 1);
    assert_eq!(tables[0].page, Some(2));
  }

  #[test]
  fn page_is_none_without_markers() {
    let md = "| A | B |\n|---|---|\n| 1 | 2 |\n";
    let tables = parse_md_tables(md);
    assert_eq!(tables[0].page, None);
  }

  #[test]
  fn ocr_comment_is_not_a_page_marker() {
    let md = "<!-- OCR skipped (page 2): no OCR provider configured -->\n\n| A |\n|---|\n| 1 |\n";
    let tables = parse_md_tables(md);
    assert_eq!(tables.len(), 1);
    assert_eq!(tables[0].page, None);
  }

  #[test]
  fn export_writes_xlsx() {
    let md_path = std::env::temp_dir().join("md2xlsx_sample.md");
    let xlsx_path = std::env::temp_dir().join("md2xlsx_sample_out.xlsx");
    std::fs::write(
      &md_path,
      "| Col A | Col B |\n|---|---|\n| 1 | x |\n| 2 | y |\n",
    )
    .unwrap();
    let res = export_markdown_tables(
      md_path.to_str().unwrap(),
      xlsx_path.to_str().unwrap(),
      true,
      false,
      false,
    )
    .unwrap();
    assert_eq!(res.table_count, 1);
    assert_eq!(res.total_rows, 2);
    assert!(xlsx_path.exists());
    assert!(xlsx_path.metadata().unwrap().len() > 0);
    std::fs::remove_file(&md_path).ok();
    std::fs::remove_file(&xlsx_path).ok();
  }

  #[test]
  fn export_all_data_includes_plain_text() {
    let md_path = std::env::temp_dir().join("md2xlsx_all_data.md");
    let xlsx_path = std::env::temp_dir().join("md2xlsx_all_data_out.xlsx");
    std::fs::write(
      &md_path,
      "intro paragraph\n\n| Col A | Col B |\n|---|---|\n| 1 | x |\n\noutro text\n",
    )
    .unwrap();
    let res = export_markdown_tables(
      md_path.to_str().unwrap(),
      xlsx_path.to_str().unwrap(),
      false,
      false,
      false,
    )
    .unwrap();
    assert_eq!(res.table_count, 1);
    assert_eq!(res.total_rows, 3); // intro, 1 table row, outro
    assert!(xlsx_path.exists());
    assert!(xlsx_path.metadata().unwrap().len() > 0);
    std::fs::remove_file(&md_path).ok();
    std::fs::remove_file(&xlsx_path).ok();
  }

  #[test]
  fn export_errors_without_tables() {
    let md_path = std::env::temp_dir().join("md2xlsx_sample2.md");
    let xlsx_path = std::env::temp_dir().join("md2xlsx_sample2_out.xlsx");
    std::fs::write(&md_path, "just some text\n").unwrap();
    let res = export_markdown_tables(
      md_path.to_str().unwrap(),
      xlsx_path.to_str().unwrap(),
      true,
      false,
      false,
    );
    assert!(res.is_err());
    std::fs::remove_file(&md_path).ok();
  }

  #[test]
  fn strip_inline_markdown_removes_emphasis_links_and_code() {
    assert_eq!(strip_inline_markdown("**bold**"), "bold");
    assert_eq!(strip_inline_markdown("`code` sample"), "code sample");
    assert_eq!(strip_inline_markdown("[link](https://example.com)"), "link");
    assert_eq!(strip_inline_markdown("*a* and __b__"), "a and b");
    assert_eq!(strip_inline_markdown("plain cell"), "plain cell");
  }

  #[test]
  fn sniff_number_classifies_conservatively() {
    assert_eq!(sniff_number("123"), Some(NumberCell::Num(123.0)));
    assert_eq!(sniff_number("3.14"), Some(NumberCell::Num(3.14)));
    assert_eq!(sniff_number("12%"), Some(NumberCell::Percent(0.12)));
    assert_eq!(sniff_number("0"), Some(NumberCell::Num(0.0)));
    // Leading zero, thousands separators and non-numbers stay text.
    assert_eq!(sniff_number("0012"), None);
    assert_eq!(sniff_number("1,234.5"), None);
    assert_eq!(sniff_number("abc"), None);
    assert_eq!(sniff_number(""), None);
  }

  #[test]
  fn export_with_numeric_and_strip_flags_writes_workbook() {
    let md_path = std::env::temp_dir().join("md2xlsx_flags.md");
    let xlsx_path = std::env::temp_dir().join("md2xlsx_flags_out.xlsx");
    std::fs::write(
      &md_path,
      "| Col A | Col B |\n|---|---|\n| **bold** | 123 |\n| [x](https://e.com) | 12% |\n",
    )
    .unwrap();
    // Numeric cells on (write_numeric=true) + Markdown stripping on.
    let res = export_markdown_tables(
      md_path.to_str().unwrap(),
      xlsx_path.to_str().unwrap(),
      true,
      true,
      true,
    )
    .unwrap();
    assert_eq!(res.table_count, 1);
    assert_eq!(res.total_rows, 2);
    assert!(xlsx_path.exists());
    assert!(xlsx_path.metadata().unwrap().len() > 0);
    std::fs::remove_file(&md_path).ok();
    std::fs::remove_file(&xlsx_path).ok();
  }
}
