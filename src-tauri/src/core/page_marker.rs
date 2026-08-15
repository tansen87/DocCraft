//! Page markers embedded in PDF-converted Markdown so downstream tooling
//! (e.g. Markdown → Excel export) can attribute tables to their source page.

const MARKER_PREFIX: &str = "<!-- 第 ";
const MARKER_SUFFIX: &str = " 页 -->";

/// The inline comment used to delimit PDF pages in converted Markdown.
pub fn page_marker(page: u32) -> String {
  format!("{MARKER_PREFIX}{page}{MARKER_SUFFIX}")
}

/// Extract the page number from a line if it is exactly a page marker
/// (`<!-- 第 N 页 -->`), otherwise `None`. Other `<!-- … -->` comments (OCR
/// failures, draw-table) never match because the prefix must be exact.
pub fn page_from_line(line: &str) -> Option<u32> {
  let body = line
    .trim()
    .strip_prefix(MARKER_PREFIX)?
    .strip_suffix(MARKER_SUFFIX)?;
  body.trim().parse::<u32>().ok()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn marker_round_trips() {
    let m = page_marker(3);
    assert_eq!(m, "<!-- 第 3 页 -->");
    assert_eq!(page_from_line(&m), Some(3));
  }

  #[test]
  fn only_exact_marker_matches() {
    assert_eq!(page_from_line("<!-- OCR 失败(第 2 页): boom -->"), None);
    assert_eq!(page_from_line("<!-- 划线提取表格 -->"), None);
    assert_eq!(page_from_line("plain text"), None);
    assert_eq!(page_from_line("<!-- 第 3 页-->"), None);
  }
}
