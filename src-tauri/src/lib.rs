mod core;
mod models;

use tauri::Manager;

use crate::core::ocr::HybridStore;
use crate::models::{
  AppSettings, ConvertResult, DetectResult, DrawTableRequest, DrawTableResult, HybridSessionInfo,
  MdAnalyzeResult, MdExportResult, OcrVendorDto, OcrVendorInput,
};

/// Classify a PDF without extracting: returns type, confidence and which
/// pages need OCR. The extraction behind `pages_needing_ocr` is cached so a
/// following conversion reuses it.
#[tauri::command]
async fn detect_pdf(app: tauri::AppHandle, path: String) -> Result<DetectResult, String> {
  let use_cache = core::settings::get_app_settings(&app)?.cache_extracted_text;
  tauri::async_runtime::spawn_blocking(move || core::convert::detect_pdf(&path, use_cache))
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Convert a PDF to Markdown locally via pdf-inspector.
#[tauri::command]
async fn convert_pdf(app: tauri::AppHandle, path: String) -> Result<ConvertResult, String> {
  let use_cache = core::settings::get_app_settings(&app)?.cache_extracted_text;
  tauri::async_runtime::spawn_blocking(move || core::convert::convert_pdf(&path, use_cache))
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Write Markdown content to a user-chosen file path.
#[tauri::command]
async fn export_markdown(path: String, content: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || core::convert::export_markdown(&path, &content))
    .await
    .map_err(|e| e.to_string())?
}

/// Begin a hybrid conversion session: text pages are extracted once and kept on
/// the backend; OCR pages are then streamed in one at a time.
#[tauri::command]
async fn hybrid_session_start(
  app: tauri::AppHandle,
  path: String,
  ocr_pages: Vec<u32>,
) -> Result<HybridSessionInfo, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let store = app.state::<HybridStore>();
    core::ocr::start_session(&app, &store, &path, ocr_pages)
  })
  .await
  .map_err(|e| e.to_string())?
}

/// Send one rendered page to the OCR provider inside the session. The image is
/// dropped as soon as this returns, so only a single page is in memory.
#[tauri::command]
async fn hybrid_page_ocr(
  state: tauri::State<'_, HybridStore>,
  session_id: String,
  page: u32,
  image_png: String,
) -> Result<String, String> {
  core::ocr::ocr_page_in_session(&state, &session_id, page, &image_png).await
}

/// Reassemble text + OCR pages in document order and discard the session.
#[tauri::command]
async fn hybrid_session_finish(
  app: tauri::AppHandle,
  session_id: String,
) -> Result<ConvertResult, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let store = app.state::<HybridStore>();
    core::ocr::finish_session(&store, &session_id)
  })
  .await
  .map_err(|e| e.to_string())?
}

/// Abandon a session (cancelled / failed before finishing).
#[tauri::command]
async fn hybrid_session_abort(
  state: tauri::State<'_, HybridStore>,
  session_id: String,
) -> Result<(), String> {
  core::ocr::abort_session(&state, &session_id)
}

/// Load OCR vendor configs. API keys are never sent back; only `api_key_set`.
#[tauri::command]
async fn get_ocr_config(app: tauri::AppHandle) -> Result<Vec<OcrVendorDto>, String> {
  core::settings::get_ocr_config(&app)
    .map(|vendors| vendors.into_iter().map(|v| v.to_dto()).collect())
}

/// Persist OCR vendor configs (API keys are protected at rest).
#[tauri::command]
async fn save_ocr_config(
  app: tauri::AppHandle,
  vendors: Vec<OcrVendorInput>,
) -> Result<(), String> {
  core::settings::save_ocr_config(&app, vendors)
}

/// Decrypt and return the stored key for a vendor ("show key" in settings).
#[tauri::command]
async fn reveal_ocr_key(
  app: tauri::AppHandle,
  vendor_id: String,
) -> Result<Option<String>, String> {
  core::settings::api_key_for(&app, &vendor_id)
}

/// Load global app settings (e.g. batch conversion concurrency).
#[tauri::command]
async fn get_app_settings(app: tauri::AppHandle) -> Result<AppSettings, String> {
  core::settings::get_app_settings(&app)
}

/// Persist global app settings.
#[tauri::command]
async fn set_app_settings(app: tauri::AppHandle, settings: AppSettings) -> Result<(), String> {
  core::settings::set_app_settings(&app, settings)
}

/// Analyze a Markdown file and return every table it contains (for preview).
#[tauri::command]
async fn analyze_markdown(path: String) -> Result<MdAnalyzeResult, String> {
  tauri::async_runtime::spawn_blocking(move || core::md_to_xlsx::analyze_markdown(&path))
    .await
    .map_err(|e| e.to_string())?
}

/// Export the Markdown content of a file (tables only, or the whole document)
/// into a `.xlsx` workbook.
#[tauri::command]
async fn export_markdown_tables(
  app: tauri::AppHandle,
  md_path: String,
  xlsx_path: String,
) -> Result<MdExportResult, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let tables_only = core::settings::get_app_settings(&app)?.excel_tables_only;
    core::md_to_xlsx::export_markdown_tables(&md_path, &xlsx_path, tables_only)
  })
  .await
  .map_err(|e| e.to_string())?
}

/// Extract tables from a PDF based on user-drawn lines.
#[tauri::command]
async fn extract_draw_table(
  app: tauri::AppHandle,
  path: String,
  draw_data: DrawTableRequest,
) -> Result<DrawTableResult, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let use_cache = core::settings::get_app_settings(&app)?.cache_extracted_text;
    core::line_draw::extract_tables_from_draw_lines(&path, &draw_data, use_cache)
  })
  .await
  .map_err(|e| e.to_string())?
}

/// Extract tables from user-drawn lines and merge them into an existing Markdown document.
#[tauri::command]
async fn extract_draw_table_to_markdown(
  app: tauri::AppHandle,
  path: String,
  draw_data: DrawTableRequest,
  existing_markdown: Option<String>,
) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let use_cache = core::settings::get_app_settings(&app)?.cache_extracted_text;
    core::line_draw::extract_tables_and_merge(
      &path,
      &draw_data,
      existing_markdown.as_deref(),
      use_cache,
    )
  })
  .await
  .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(HybridStore::default())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      detect_pdf,
      convert_pdf,
      hybrid_session_start,
      hybrid_page_ocr,
      hybrid_session_finish,
      hybrid_session_abort,
      export_markdown,
      get_ocr_config,
      save_ocr_config,
      reveal_ocr_key,
      get_app_settings,
      set_app_settings,
      analyze_markdown,
      export_markdown_tables,
      extract_draw_table,
      extract_draw_table_to_markdown
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
