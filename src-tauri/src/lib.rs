mod core;
mod models;

use std::sync::Mutex;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{Listener, Manager};

use crate::core::ocr::HybridStore;
use crate::core::snip::{SnipStore, get_window_under_cursor};
use crate::models::{
  AppSettings, ConvertResult, DetectResult, DrawTableRequest, DrawTableResult, ExcludeRegions,
  HybridSessionInfo, ImageTableRequest, ImageTableResult, MdAnalyzeResult, MdExportResult,
  MonitorSnapshot, OcrImageResult, OcrVendorDto, OcrVendorInput, ShotRegion, UsageInput,
  UsageStats,
};

/// Managed tray icon state so we can rebuild it when settings change.
pub struct TrayState(pub Mutex<Option<TrayIcon>>);

impl Default for TrayState {
  fn default() -> Self {
    Self(Mutex::new(None))
  }
}

/// Create the system tray icon with menu items.
fn setup_tray(app: &tauri::AppHandle) -> Result<TrayIcon, Box<dyn std::error::Error>> {
  let open = MenuItemBuilder::with_id("open", "Open").build(app)?;
  let screenshot = MenuItemBuilder::with_id("screenshot", "Screenshot").build(app)?;
  let quit = MenuItemBuilder::with_id("quit", "Exit").build(app)?;
  let menu = MenuBuilder::new(app)
    .item(&open)
    .item(&screenshot)
    .separator()
    .item(&quit)
    .build()?;

  let icon = app
    .default_window_icon()
    .cloned()
    .ok_or("No default window icon")?;

  let tray = TrayIconBuilder::new()
    .icon(icon)
    .menu(&menu)
    .tooltip("DocCraft")
    .on_menu_event(|app, event| match event.id().as_ref() {
      "open" => {
        if let Some(window) = app.get_webview_window("main") {
          let _ = window.show();
          let _ = window.set_focus();
        }
      }
      "screenshot" => {
        let app = app.clone();
        tauri::async_runtime::spawn(async {
          crate::core::snip::capture_and_emit(app).await;
        });
      }
      "quit" => {
        app.exit(0);
      }
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        let app = tray.app_handle();
        if let Some(window) = app.get_webview_window("main") {
          let _ = window.show();
          let _ = window.set_focus();
        }
      }
    })
    .build(app)?;

  Ok(tray)
}

/// Synchronise the tray icon with the persisted setting.
/// Creates the tray if `enabled` and not already present; drops it otherwise.
pub fn update_tray(app: &tauri::AppHandle, enabled: bool) {
  let state = app.state::<TrayState>();
  let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
  if enabled && guard.is_none() {
    match setup_tray(app) {
      Ok(tray) => *guard = Some(tray),
      Err(e) => eprintln!("Failed to create tray icon: {e}"),
    }
  } else if !enabled && guard.is_some() {
    // Dropping the TrayIcon removes it from the system tray.
    *guard = None;
  }
}

/// Classify a PDF without extracting: returns type, confidence and which
/// pages need OCR. The extraction behind `pages_needing_ocr` is cached so a
/// following conversion reuses it.
#[tauri::command]
async fn detect_pdf(app: tauri::AppHandle, path: String) -> Result<DetectResult, String> {
  let settings = core::settings::get_app_settings(&app)?;
  let use_cache = settings.cache_extracted_text;
  let text_separator = settings.text_separator;
  tauri::async_runtime::spawn_blocking(move || {
    core::convert::detect_pdf(&path, use_cache, &text_separator)
  })
  .await
  .map_err(|e| e.to_string())?
  .map_err(|e| e.to_string())
}

/// Convert a PDF to Markdown locally via pdf-inspector.
#[tauri::command]
async fn convert_pdf(
  app: tauri::AppHandle,
  path: String,
  page_range: Option<String>,
  exclusions: Option<ExcludeRegions>,
) -> Result<ConvertResult, String> {
  let settings = core::settings::get_app_settings(&app)?;
  let use_cache = settings.cache_extracted_text;
  let text_separator = settings.text_separator;
  tauri::async_runtime::spawn_blocking(move || {
    core::convert::convert_pdf(
      &path,
      use_cache,
      page_range.as_deref(),
      exclusions.as_ref(),
      &text_separator,
    )
  })
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
  page_range: Option<String>,
  exclusions: Option<ExcludeRegions>,
) -> Result<HybridSessionInfo, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let store = app.state::<HybridStore>();
    core::ocr::start_session(
      &app,
      &store,
      &path,
      ocr_pages,
      page_range.as_deref(),
      exclusions.as_ref(),
    )
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

/// Persist global app settings, then sync every runtime consumer (screenshot
/// hotkey, tray icon, OCR engine cache). Shared by the `set_app_settings`
/// command and configuration import.
fn apply_app_settings(app: &tauri::AppHandle, settings: AppSettings) -> Result<(), String> {
  let before = core::settings::get_app_settings(app)?;
  core::settings::set_app_settings(app, settings)?;
  // Keep the global screenshot hotkey in sync (this also validates it - an
  // unparsable hotkey fails the save).
  core::snip::apply_hotkey(app)?;
  // Sync the tray icon with the new setting.
  let settings_now = core::settings::get_app_settings(app)?;
  if settings_now.enable_tray != before.enable_tray {
    update_tray(app, settings_now.enable_tray);
  }
  // Inference-parameter changes (precision / model tier) invalidate the
  // resident engines so the next use rebuilds them with the new settings
  // (docs/design/00005_snip-local-ocr-latency.md S-1).
  let engine_params_changed = settings_now.ocr_low_precision != before.ocr_low_precision
    || settings_now.ocr_model_size != before.ocr_model_size;
  if engine_params_changed {
    app.state::<core::ocr::OcrEngineCache>().clear();
    app.state::<core::ocr::SnipEngineCache>().clear();
  }
  Ok(())
}

/// Persist global app settings.
#[tauri::command]
async fn set_app_settings(app: tauri::AppHandle, settings: AppSettings) -> Result<(), String> {
  apply_app_settings(&app, settings)
}

/// Append one usage event to the local JSONL stats log (never uploaded).
#[tauri::command]
async fn record_usage(app: tauri::AppHandle, entry: UsageInput) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || core::usage_stats::record_usage(&app, entry))
    .await
    .map_err(|e| e.to_string())?
}

/// Aggregate the local usage log into today / month / total counters.
/// `today` is the frontend-computed local date (`YYYY-MM-DD`).
#[tauri::command]
async fn get_usage_stats(app: tauri::AppHandle, today: String) -> Result<UsageStats, String> {
  tauri::async_runtime::spawn_blocking(move || core::usage_stats::get_usage_stats(&app, &today))
    .await
    .map_err(|e| e.to_string())?
}

/// Delete the local usage log ("clear statistics" in settings).
#[tauri::command]
async fn clear_usage_stats(app: tauri::AppHandle) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || core::usage_stats::clear_usage_stats(&app))
    .await
    .map_err(|e| e.to_string())?
}

/// Export the full configuration (app settings + OCR vendors) to a JSON file.
/// When `include_secrets` is set, API keys are decrypted into **plaintext** -
/// the frontend warns before choosing this option.
#[tauri::command]
async fn export_config(
  app: tauri::AppHandle,
  path: String,
  include_secrets: bool,
) -> Result<usize, String> {
  tauri::async_runtime::spawn_blocking(move || {
    core::config_transfer::export_config(&app, &path, include_secrets)
  })
  .await
  .map_err(|e| e.to_string())?
}

/// Import a previously exported configuration file. Vendors are merged by id
/// (local entries not present in the file are kept); imported settings go
/// through the same side-effect pipeline as a manual save.
#[tauri::command]
async fn import_config(
  app: tauri::AppHandle,
  path: String,
) -> Result<core::config_transfer::ImportResult, String> {
  let imported =
    tauri::async_runtime::spawn_blocking(move || core::config_transfer::parse_import(&path))
      .await
      .map_err(|e| e.to_string())??;

  let mut vendors_imported = 0usize;
  if let Some(vendors) = &imported.ocr_vendors {
    let list = vendors.clone();
    let handle = app.clone();
    vendors_imported = tauri::async_runtime::spawn_blocking(move || {
      core::config_transfer::merge_vendors(&handle, list)
    })
    .await
    .map_err(|e| e.to_string())??;
  }

  let mut settings_applied = false;
  if let Some(settings) = imported.app_settings {
    apply_app_settings(&app, settings)?;
    settings_applied = true;
  }

  Ok(core::config_transfer::ImportResult {
    vendors_imported,
    settings_applied,
  })
}

/// Ask the configured update endpoint whether a newer release exists.
/// Network / parse failures return an error string; the frontend ignores it.
#[tauri::command]
async fn check_for_update(
  app: tauri::AppHandle,
) -> Result<Option<core::update::UpdateInfo>, String> {
  core::update::check_for_update(&app).await
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

/// Extract a GFM table from an image using OCR + user-drawn vertical lines.
#[tauri::command]
async fn ocr_image_table(
  app: tauri::AppHandle,
  request: ImageTableRequest,
) -> Result<ImageTableResult, String> {
  core::snip::ocr_image_table(&app, request).await
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
    let settings = core::settings::get_app_settings(&app)?;
    let use_cache = settings.cache_extracted_text;
    let high_precision = settings.draw_table_high_precision;
    let text_separator = settings.text_separator;
    let (local, remote) = resolve_draw_ocr(&app, &draw_data)?;
    let remote_prompt = core::ocr::effective_draw_table_prompt(&app)?;
    let engines = core::line_draw::DrawOcrEngines {
      local: local.as_ref(),
      remote: remote.as_ref(),
      remote_prompt: &remote_prompt,
    };
    core::line_draw::extract_tables_from_draw_lines(
      &path,
      &draw_data,
      use_cache,
      high_precision,
      Some(&engines),
      &text_separator,
    )
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
    let settings = core::settings::get_app_settings(&app)?;
    let use_cache = settings.cache_extracted_text;
    let high_precision = settings.draw_table_high_precision;
    let text_separator = settings.text_separator;
    let (local, remote) = resolve_draw_ocr(&app, &draw_data)?;
    let remote_prompt = core::ocr::effective_draw_table_prompt(&app)?;
    let engines = core::line_draw::DrawOcrEngines {
      local: local.as_ref(),
      remote: remote.as_ref(),
      remote_prompt: &remote_prompt,
    };
    core::line_draw::extract_tables_and_merge(
      &path,
      &draw_data,
      existing_markdown.as_deref(),
      use_cache,
      high_precision,
      Some(&engines),
      &text_separator,
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
    .manage(core::ocr::OcrEngineCache::default())
    .manage(core::ocr::SnipEngineCache::default())
    .manage(TrayState::default())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_clipboard_manager::init())
    .plugin(
      tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
          use tauri_plugin_global_shortcut::ShortcutState;
          if event.state() == ShortcutState::Pressed {
            let app = app.clone();
            tauri::async_runtime::spawn(async {
              crate::core::snip::capture_and_emit(app).await;
            });
          }
        })
        .build(),
    )
    .setup(|app| {
      let handle = app.handle().clone();
      if let Err(e) = crate::core::snip::apply_hotkey(&handle) {
        eprintln!("Failed to register screenshot hotkey: {e}");
      }
      // Listen for the button-click capture trigger (same as the hotkey path).
      let handle = app.handle().clone();
      app.listen("snip:capture", move |_| {
        let h = handle.clone();
        tauri::async_runtime::spawn(async move {
          crate::core::snip::capture_and_emit(h).await;
        });
      });
      // Create the system tray icon if enabled by settings.
      match crate::core::settings::get_app_settings(app.handle()) {
        Ok(settings) => {
          if settings.enable_tray {
            update_tray(app.handle(), true);
          }
        }
        Err(e) => eprintln!("Failed to load settings for tray icon: {e}"),
      }
      // When the tray is enabled, closing the window hides it to the tray
      // instead of quitting the app. The tray "Exit" menu calls app.exit(0)
      // to fully terminate.
      if let Some(window) = app.get_webview_window("main") {
        let app_handle = app.handle().clone();
        window.on_window_event(move |event| {
          if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Check if tray is still enabled.
            let tray_active = app_handle
              .state::<TrayState>()
              .0
              .lock()
              .unwrap_or_else(|e| e.into_inner())
              .is_some();
            if tray_active {
              api.prevent_close();
              // Hide the window instead of destroying it.
              if let Some(w) = app_handle.get_webview_window("main") {
                let _ = w.hide();
              }
            }
            // If tray is not active, let the window close normally.
          }
        });
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
      record_usage,
      get_usage_stats,
      clear_usage_stats,
      export_config,
      import_config,
      check_for_update,
      analyze_markdown,
      export_markdown_tables,
      ocr_image_to_md,
      screenshot_begin,
      screenshot_ocr,
      screenshot_cancel,
      ocr_image_table,
      get_window_under_cursor,
      extract_draw_table,
      extract_draw_table_to_markdown
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
