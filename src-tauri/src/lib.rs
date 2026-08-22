mod core;
mod models;

use tauri::Manager;

use crate::core::ocr::HybridStore;
use crate::core::snip::SnipStore;
use crate::models::{
  AppSettings, ConvertResult, DetectResult, DrawTableRequest, DrawTableResult, HybridSessionInfo,
  MdAnalyzeResult, MdExportResult, MonitorSnapshot, OcrImageResult, OcrVendorDto, OcrVendorInput,
  ShotRegion,
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
  app: tauri::AppHandle,
  hybrid_store: tauri::State<'_, HybridStore>,
  session_id: String,
  page: u32,
  image_png: String,
) -> Result<String, String> {
  core::ocr::ocr_page_in_session(&hybrid_store, &session_id, page, &image_png, &app).await
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
  core::settings::set_app_settings(&app, settings)?;
  // Keep the global screenshot hotkey in sync (this also validates it — an
  // unparsable hotkey fails the save).
  core::snip::apply_hotkey(&app)
}

/// Convert one standalone image file (PNG / JPEG) to Markdown via the OCR
/// engine selected by the current mode.
#[tauri::command]
async fn ocr_image_to_md(app: tauri::AppHandle, path: String) -> Result<OcrImageResult, String> {
  core::ocr::convert_image_to_md(&app, &path).await
}

/// Freeze every monitor into a snapshot for region selection. Hides the main
/// window; the follow-up `screenshot_ocr` / `screenshot_cancel` restores it.
#[tauri::command]
async fn screenshot_begin(app: tauri::AppHandle) -> Result<Vec<MonitorSnapshot>, String> {
  core::snip::begin_screenshot(&app).await
}

/// Recognize the selected monitor region and finish the snip session: cached
/// snapshots are dropped and the main window is restored either way.
#[tauri::command]
async fn screenshot_ocr(
  app: tauri::AppHandle,
  region: ShotRegion,
) -> Result<OcrImageResult, String> {
  let result = core::snip::screenshot_ocr(&app, region).await;
  core::snip::end_screenshot_session(&app);
  result
}

/// Cancel an in-progress snip session (Esc / overlay closed).
#[tauri::command]
async fn screenshot_cancel(app: tauri::AppHandle) -> Result<(), String> {
  core::snip::end_screenshot_session(&app);
  Ok(())
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
///
/// When the request carries rendered page images, the OCR fallback selected
/// by the current mode is prepared: local PaddleOCR for `forceLocal` /
/// `nonTextLocal`, remote AI vision for `forceAi` / `nonTextAi`, nothing for
/// `disabled`. Missing local models or an unconfigured provider degrade the
/// extraction to text-only instead of failing.
#[tauri::command]
async fn extract_draw_table(
  app: tauri::AppHandle,
  path: String,
  draw_data: DrawTableRequest,
) -> Result<DrawTableResult, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let use_cache = core::settings::get_app_settings(&app)?.cache_extracted_text;
    let (local, remote) = resolve_draw_ocr(&app, &draw_data)?;
    let engines = core::line_draw::DrawOcrEngines {
      local: local.as_ref(),
      remote: remote.as_ref(),
    };
    core::line_draw::extract_tables_from_draw_lines(&path, &draw_data, use_cache, Some(&engines))
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
    let (local, remote) = resolve_draw_ocr(&app, &draw_data)?;
    let engines = core::line_draw::DrawOcrEngines {
      local: local.as_ref(),
      remote: remote.as_ref(),
    };
    core::line_draw::extract_tables_and_merge(
      &path,
      &draw_data,
      existing_markdown.as_deref(),
      use_cache,
      Some(&engines),
    )
  })
  .await
  .map_err(|e| e.to_string())?
}

/// Resolve the OCR engines for a draw-table request based on the user's
/// selected mode. Returns `(local_engine, remote_provider)`; both are `None`
/// unless page images are attached to the request.
fn resolve_draw_ocr(
  app: &tauri::AppHandle,
  draw_data: &DrawTableRequest,
) -> Result<
  (
    Option<core::ocr::LocalOcrEngine>,
    Option<core::ocr::RemoteOcrProvider>,
  ),
  String,
> {
  use crate::models::OcrMode;

  if !draw_data
    .page_images
    .as_ref()
    .is_some_and(|imgs| !imgs.is_empty())
  {
    return Ok((None, None));
  }

  let mode = core::settings::get_app_settings(app)?.ocr_mode;
  match mode {
    OcrMode::ForceLocal | OcrMode::NonTextLocal => {
      Ok((core::ocr::create_local_ocr_engine(app).ok(), None))
    }
    OcrMode::ForceAi | OcrMode::NonTextAi => Ok((None, core::ocr::resolve_remote_provider(app)?)),
    OcrMode::Disabled => Ok((None, None)),
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(HybridStore::default())
    .manage(SnipStore::default())
    .manage(crate::core::snip::SnipHotkey::default())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(
      tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
          use tauri_plugin_global_shortcut::ShortcutState;
          if event.state() == ShortcutState::Pressed {
            // The frontend routes this into the snip flow.
            use tauri::Emitter;
            let _ = app.emit("snip:hotkey", ());
          }
        })
        .build(),
    )
    .setup(|app| {
      let handle = app.handle().clone();
      if let Err(e) = crate::core::snip::apply_hotkey(&handle) {
        eprintln!("Failed to register screenshot hotkey: {e}");
      }
      Ok(())
    })
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
      ocr_image_to_md,
      screenshot_begin,
      screenshot_ocr,
      screenshot_cancel,
      extract_draw_table,
      extract_draw_table_to_markdown
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
