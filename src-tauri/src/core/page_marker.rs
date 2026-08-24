//! Page markers embedded in PDF-converted Markdown so downstream tooling
//! (e.g. Markdown > Excel export) can attribute tables to their source page.

/// English marker emitted into converted Markdown (`<!-- Page N -->`).
const EN_PREFIX: &str = "<!-- Page ";
const EN_SUFFIX: &str = " -->";
/// Legacy Chinese marker (`<!-- 第 N 页 -->`) accepted when parsing so older
/// converted documents keep their page attribution.
const ZH_PREFIX: &str = "<!-- 第 ";
const ZH_SUFFIX: &str = " 页 -->";

/// The inline comment used to delimit PDF pages in converted Markdown.
pub fn page_marker(page: u32) -> String {
  format!("{EN_PREFIX}{page}{EN_SUFFIX}")
}

/// Extract the page number from a line if it is exactly a page marker
/// (`<!-- Page N -->` or the legacy `<!-- 第 N 页 -->`), otherwise `None`.
/// Other `<!-- … -->` comments (OCR failures, draw-table) never match because
/// the prefix/suffix must be exact.
pub fn page_from_line(line: &str) -> Option<u32> {
  parse_marker(line, EN_PREFIX, EN_SUFFIX).or_else(|| parse_marker(line, ZH_PREFIX, ZH_SUFFIX))
}

fn parse_marker(line: &str, prefix: &str, suffix: &str) -> Option<u32> {
  let body = line.trim().strip_prefix(prefix)?.strip_suffix(suffix)?;
  body.trim().parse::<u32>().ok()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn marker_round_trips() {
    let m = page_marker(3);
    assert_eq!(m, "<!-- Page 3 -->");
    assert_eq!(page_from_line(&m), Some(3));
  }

  #[test]
  fn legacy_chinese_marker_still_parses() {
    assert_eq!(page_from_line("<!-- 第 3 页 -->"), Some(3));
  }

  #[test]
  fn only_exact_marker_matches() {
    assert_eq!(page_from_line("<!-- OCR failed (page 2): boom -->"), None);
    assert_eq!(page_from_line("<!-- OCR 失败(第 2 页): boom -->"), None);
    assert_eq!(
      page_from_line("<!-- Draw lines to extract tables -->"),
      None
    );
    assert_eq!(page_from_line("plain text"), None);
    assert_eq!(page_from_line("<!-- Page 3-->"), None);
    assert_eq!(page_from_line("<!-- 第 3 页-->"), None);
  }
}
