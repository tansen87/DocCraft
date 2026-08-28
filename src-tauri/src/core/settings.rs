use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

use tauri::AppHandle;

use crate::core::get_resources_dir;
use crate::core::secret;
use crate::models::{AppSettings, OcrVendor, OcrVendorInput};

const CONFIG_FILE: &str = "ocr-config.json";
const APP_SETTINGS_FILE: &str = "app-settings.json";
const MAX_CONCURRENT_LIMIT: u32 = 16;

pub fn data_dir(_app: &AppHandle) -> Result<PathBuf, String> {
  let dir = get_resources_dir().join("data");
  if !dir.exists() {
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create data directory: {e}"))?;
  }
  Ok(dir)
}

fn app_config_file(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
  let dir = data_dir(app)?;
  Ok(dir.join(file))
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
  app_config_file(app, CONFIG_FILE)
}

fn app_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
  app_config_file(app, APP_SETTINGS_FILE)
}

fn load_vendors(path: &std::path::Path) -> Vec<OcrVendor> {
  std::fs::read_to_string(path)
    .ok()
    .and_then(|text| serde_json::from_str::<Vec<OcrVendor>>(&text).ok())
    .unwrap_or_default()
}

/// Return the persisted vendors. API keys are kept protected and never
/// serialized back to the frontend.
pub fn get_ocr_config(app: &AppHandle) -> Result<Vec<OcrVendor>, String> {
  Ok(load_vendors(&config_path(app)?))
}

/// Persist vendors, replacing the whole list. Secrets are resolved per entry:
/// - `clear_api_key` empties the stored key.
/// - otherwise an empty `api_key` keeps the previously stored secret.
/// - otherwise the new key is protected and stored.
pub fn save_ocr_config(app: &AppHandle, inputs: Vec<OcrVendorInput>) -> Result<(), String> {
  let path = config_path(app)?;
  let existing = load_vendors(&path);

  let vendors: Vec<OcrVendor> = inputs
    .into_iter()
    .map(|input| {
      let key = if input.clear_api_key {
        None
      } else if input.api_key.trim().is_empty() {
        existing
          .iter()
          .find(|v| v.id == input.id)
          .and_then(|v| v.api_key.clone())
      } else {
        Some(secret::protect(input.api_key.trim())?)
      };
      Ok(OcrVendor {
        id: input.id,
        name: input.name,
        base_url: input.base_url,
        api_key: key,
        models: input.models,
      })
    })
    .collect::<Result<Vec<_>, String>>()?;

  let dir = path
    .parent()
    .ok_or_else(|| "Invalid configuration directory".to_string())?;
  std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  let json = serde_json::to_string_pretty(&vendors).map_err(|e| e.to_string())?;
  std::fs::write(&path, json).map_err(|e| e.to_string())?;
  Ok(())
}

/// Decrypt and return the stored key for a vendor (used by OCR pipeline or
/// "show key" in settings).
pub fn api_key_for(app: &AppHandle, vendor_id: &str) -> Result<Option<String>, String> {
  let vendors = load_vendors(&config_path(app)?);
  Ok(
    vendors
      .iter()
      .find(|v| v.id == vendor_id)
      .and_then(|v| v.api_key.as_deref())
      .and_then(secret::unprotect),
  )
}

/// Process-wide settings cache. `get_app_settings` is called several times per
/// conversion / screenshot; reading the JSON file each time adds avoidable
/// latency on hot paths (see docs/design/00005_snip-local-ocr-latency.md S-4).
/// [`set_app_settings`] writes through, keeping cache and disk in sync.
static SETTINGS_CACHE: OnceLock<RwLock<Option<AppSettings>>> = OnceLock::new();

fn settings_cache() -> &'static RwLock<Option<AppSettings>> {
  SETTINGS_CACHE.get_or_init(|| RwLock::new(None))
}

/// Load global app settings (falls back to defaults when missing/corrupt).
/// Served from the in-process cache once loaded.
pub fn get_app_settings(app: &AppHandle) -> Result<AppSettings, String> {
  if let Ok(guard) = settings_cache().read() {
    if let Some(cached) = guard.as_ref() {
      return Ok(cached.clone());
    }
  }
  let path = app_settings_path(app)?;
  let settings = std::fs::read_to_string(&path)
    .ok()
    .and_then(|text| serde_json::from_str::<AppSettings>(&text).ok())
    .unwrap_or_default();
  let clamped = clamp_settings(settings);
  if let Ok(mut guard) = settings_cache().write() {
    *guard = Some(clamped.clone());
  }
  Ok(clamped)
}

/// Persist global app settings, normalizing values within valid ranges.
/// Also refreshes the in-process cache (write-through).
pub fn set_app_settings(app: &AppHandle, settings: AppSettings) -> Result<(), String> {
  let path = app_settings_path(app)?;
  let dir = path
    .parent()
    .ok_or_else(|| "Invalid configuration directory".to_string())?;
  std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  let clamped = clamp_settings(settings);
  let json = serde_json::to_string_pretty(&clamped).map_err(|e| e.to_string())?;
  std::fs::write(&path, json).map_err(|e| e.to_string())?;
  if let Ok(mut guard) = settings_cache().write() {
    *guard = Some(clamped);
  }
  Ok(())
}

fn clamp_settings(mut settings: AppSettings) -> AppSettings {
  settings.max_concurrent = settings.max_concurrent.clamp(1, MAX_CONCURRENT_LIMIT);
  settings.snip_result_opacity = settings.snip_result_opacity.clamp(0, 100);
  settings.main_window_opacity = settings.main_window_opacity.clamp(0, 100);
  settings
}
