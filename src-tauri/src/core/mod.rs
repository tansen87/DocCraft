pub mod config_transfer;
pub mod convert;
pub mod extract_cache;
pub mod grid_rebuild;
pub mod layout;
pub mod line_draw;
pub mod md_to_xlsx;
pub mod migrate;
pub mod model_files;
pub mod ocr;
pub mod page_marker;
pub mod paragraph;
pub mod region_exclude;
pub mod secret;
pub mod settings;
pub mod snip;
pub mod update;
pub mod usage_stats;

/// Directory the application is installed in - the folder holding the
/// executable. All bundled resources and the runtime-generated `data/`
/// directory live directly inside it, next to the executable
/// (docs/design/00020_update-check-and-install-layout.md §3.4).
pub fn install_dir() -> std::path::PathBuf {
  let exe_path = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("."));
  exe_path
    .parent()
    .map(std::path::Path::to_path_buf)
    .unwrap_or_else(|| std::path::PathBuf::from("."))
}

/// `<install_dir>/models` - bundled PaddleOCR tiers and the layout model pool.
pub fn models_dir() -> std::path::PathBuf {
  install_dir().join("models")
}

/// `<install_dir>/data` - runtime-generated configuration, secrets and usage
/// log (kept next to the executable, see `settings::data_dir`).
pub fn data_dir() -> std::path::PathBuf {
  install_dir().join("data")
}
