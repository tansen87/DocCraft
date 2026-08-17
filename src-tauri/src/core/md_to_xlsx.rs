use std::time::Instant;

use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Workbook};

use crate::core::page_marker::page_from_line;
use crate::models::{MdAnalyzeResult, MdExportResult, MdTable};

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

/// Extract every GitHub-Flavored Markdown table from a document. Tables that
/// follow a `<!-- Page N -->` marker are tagged with that source page.
pub fn parse_md_tables(content: &str) -> Vec<MdTable> {
  let lines: Vec<&str> = content.lines().collect();
  let mut tables = Vec::new();
  let mut current_page: Option<u32> = None;
  let mut i = 0usize;
  while i < lines.len() {
    let line = lines[i].trim();
    if let Some(page) = page_from_line(line) {
      current_page = Some(page);
      i += 1;
      continue;
    }
    let header = lines[i].trim();
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
      tables.push(MdTable {
        columns,
        rows,
        page: current_page,
      });
      i = j;
    } else {
      i += 1;
    }
  }
  tables
}

fn read_file(path: &str) -> Result<String, String> {
  std::fs::read_to_string(path).map_err(|e| format!("读取文件失败: {e}"))
}

/// Analyze a Markdown file and return every table it contains (for preview).
pub fn analyze_markdown(path: &str) -> Result<MdAnalyzeResult, String> {
  let content = read_file(path)?;
  let start = Instant::now();
  let tables = parse_md_tables(&content);
  let total_rows = tables.iter().map(|t| t.rows.len()).sum::<usize>();
  Ok(MdAnalyzeResult {
    table_count: tables.len(),
    tables,
    total_rows,
    processing_time_ms: start.elapsed().as_millis() as u64,
  })
}

/// Parse the tables from `md_path` and stack them one below the other into a
/// single worksheet of the workbook written to `xlsx_path`.
pub fn export_markdown_tables(md_path: &str, xlsx_path: &str) -> Result<MdExportResult, String> {
  let content = read_file(md_path)?;
  let start = Instant::now();
  let tables = parse_md_tables(&content);
  if tables.is_empty() {
    return Err("Table not found in Markdown".to_string());
  }

  let mut workbook = Workbook::new();
  let ws = workbook.add_worksheet();

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

  let mut row: u32 = 0;
  let mut total_rows = 0usize;
  for (idx, table) in tables.iter().enumerate() {
    let label = match table.page {
      Some(page) => format!("Page {page}"),
      None => format!("Table {}", idx + 1),
    };
    ws.write_string_with_format(row, 0, &label, &label_fmt)
      .map_err(|e| e.to_string())?;
    row += 1;
    for (col, name) in table.columns.iter().enumerate() {
      ws.write_string_with_format(row, col as u16, name, &header_fmt)
        .map_err(|e| e.to_string())?;
    }
    row += 1;
    for r in &table.rows {
      for (col, value) in r.iter().enumerate() {
        ws.write_string_with_format(row, col as u16, value, &cell_fmt)
          .map_err(|e| e.to_string())?;
      }
      row += 1;
      total_rows += 1;
    }
    row += 1;
  }
  ws.autofit();
  workbook.save(xlsx_path).map_err(|e| e.to_string())?;

  Ok(MdExportResult {
    table_count: tables.len(),
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
    let res =
      export_markdown_tables(md_path.to_str().unwrap(), xlsx_path.to_str().unwrap()).unwrap();
    assert_eq!(res.table_count, 1);
    assert_eq!(res.total_rows, 2);
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
    let res = export_markdown_tables(md_path.to_str().unwrap(), xlsx_path.to_str().unwrap());
    assert!(res.is_err());
    std::fs::remove_file(&md_path).ok();
  }
}
