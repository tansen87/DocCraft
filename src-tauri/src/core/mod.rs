pub mod config_transfer;
pub mod convert;
pub mod extract_cache;
pub mod grid_rebuild;
pub mod line_draw;
pub mod md_to_xlsx;
pub mod ocr;
pub mod page_marker;
pub mod secret;
pub mod settings;
pub mod snip;
pub mod update;

use std::path::{Path, PathBuf};

/// Returns `<exe_dir>/doccraft_resources/` as the base for all external resources.
pub fn get_resources_dir() -> PathBuf {
  let exe_path = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
  let exe_dir = exe_path.parent().unwrap_or(Path::new("."));
  exe_dir.join("doccraft_resources")
}
