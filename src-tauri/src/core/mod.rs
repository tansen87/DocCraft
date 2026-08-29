pub mod config_transfer;
pub mod convert;
pub mod extract_cache;
pub mod grid_rebuild;
pub mod line_draw;
pub mod md_to_xlsx;
pub mod ocr;
pub mod page_marker;
pub mod region_exclude;
pub mod secret;
pub mod settings;
pub mod snip;
pub mod update;
pub mod usage_stats;

/// Returns `<exe_dir>/doccraft_resources/` as the base for all external resources.
pub fn get_resources_dir() -> std::path::PathBuf {
  let exe_path = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("."));
  let exe_dir = exe_path.parent().unwrap_or(std::path::Path::new("."));
  exe_dir.join("doccraft_resources")
}
