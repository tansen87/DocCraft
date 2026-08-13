mod core;
mod models;

use crate::core::ocr::HybridStore;
use crate::models::{
  AppSettings, ConvertResult, DetectResult, HybridSessionInfo, MdAnalyzeResult, MdExportResult,
  OcrVendorDto, OcrVendorInput,
};

/// Classify a PDF without extracting: returns type, confidence and which
/// pages need OCR.
#[tauri::command]
fn detect_pdf(path: String) -> Result<DetectResult, String> {
  core::convert::detect_pdf(&path).map_err(|e| e.to_string())
}

/// Convert a PDF to Markdown locally via pdf-inspector.
#[tauri::command]
fn convert_pdf(path: String) -> Result<ConvertResult, String> {
  core::convert::convert_pdf(&path).map_err(|e| e.to_string())
}

/// Write Markdown content to a user-chosen file path.
#[tauri::command]
fn export_markdown(path: String, content: String) -> Result<(), String> {
  core::convert::export_markdown(&path, &content)
}

/// Begin a hybrid conversion session: text pages are extracted once and kept on
/// the backend; OCR pages are then streamed in one at a time.
#[tauri::command]
fn hybrid_session_start(
  app: tauri::AppHandle,
  state: tauri::State<'_, HybridStore>,
  path: String,
  ocr_pages: Vec<u32>,
) -> Result<HybridSessionInfo, String> {
  core::ocr::start_session(&app, &state, &path, ocr_pages)
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
fn hybrid_session_finish(
  state: tauri::State<'_, HybridStore>,
  session_id: String,
) -> Result<ConvertResult, String> {
  core::ocr::finish_session(&state, &session_id)
}

/// Abandon a session (cancelled / failed before finishing).
#[tauri::command]
fn hybrid_session_abort(
  state: tauri::State<'_, HybridStore>,
  session_id: String,
) -> Result<(), String> {
  core::ocr::abort_session(&state, &session_id)
}

/// Load OCR vendor configs. API keys are never sent back; only `api_key_set`.
#[tauri::command]
fn get_ocr_config(app: tauri::AppHandle) -> Result<Vec<OcrVendorDto>, String> {
  core::settings::get_ocr_config(&app)
    .map(|vendors| vendors.into_iter().map(|v| v.to_dto()).collect())
}

/// Persist OCR vendor configs (API keys are protected at rest).
#[tauri::command]
fn save_ocr_config(app: tauri::AppHandle, vendors: Vec<OcrVendorInput>) -> Result<(), String> {
  core::settings::save_ocr_config(&app, vendors)
}

/// Decrypt and return the stored key for a vendor ("show key" in settings).
#[tauri::command]
fn reveal_ocr_key(app: tauri::AppHandle, vendor_id: String) -> Result<Option<String>, String> {
  core::settings::api_key_for(&app, &vendor_id)
}

/// Load global app settings (e.g. batch conversion concurrency).
#[tauri::command]
fn get_app_settings(app: tauri::AppHandle) -> Result<AppSettings, String> {
  core::settings::get_app_settings(&app)
}

/// Persist global app settings.
#[tauri::command]
fn set_app_settings(app: tauri::AppHandle, settings: AppSettings) -> Result<(), String> {
  core::settings::set_app_settings(&app, settings)
}

/// Analyze a Markdown file and return every table it contains (for preview).
#[tauri::command]
fn analyze_markdown(path: String) -> Result<MdAnalyzeResult, String> {
  core::md_to_xlsx::analyze_markdown(&path)
}

/// Export all tables of a Markdown file into a `.xlsx` workbook.
#[tauri::command]
fn export_markdown_tables(md_path: String, xlsx_path: String) -> Result<MdExportResult, String> {
  core::md_to_xlsx::export_markdown_tables(&md_path, &xlsx_path)
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
      export_markdown_tables
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
