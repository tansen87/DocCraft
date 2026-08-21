use std::path::PathBuf;

use tauri::AppHandle;

use crate::core::get_resources_dir;
use crate::core::secret;
use crate::models::{AppSettings, OcrVendor, OcrVendorInput};

const CONFIG_FILE: &str = "ocr-config.json";
const APP_SETTINGS_FILE: &str = "app-settings.json";
const MAX_CONCURRENT_LIMIT: u32 = 16;

fn data_dir(_app: &AppHandle) -> Result<PathBuf, String> {
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

/// Load global app settings (falls back to defaults when missing/corrupt).
pub fn get_app_settings(app: &AppHandle) -> Result<AppSettings, String> {
  let path = app_settings_path(app)?;
  let settings = std::fs::read_to_string(&path)
    .ok()
    .and_then(|text| serde_json::from_str::<AppSettings>(&text).ok())
    .unwrap_or_default();
  Ok(clamp_settings(settings))
}

/// Persist global app settings, normalizing values within valid ranges.
pub fn set_app_settings(app: &AppHandle, settings: AppSettings) -> Result<(), String> {
  let path = app_settings_path(app)?;
  let dir = path
    .parent()
    .ok_or_else(|| "Invalid configuration directory".to_string())?;
  std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  let json = serde_json::to_string_pretty(&clamp_settings(settings)).map_err(|e| e.to_string())?;
  std::fs::write(&path, json).map_err(|e| e.to_string())?;
  Ok(())
}

fn clamp_settings(mut settings: AppSettings) -> AppSettings {
  settings.max_concurrent = settings.max_concurrent.clamp(1, MAX_CONCURRENT_LIMIT);
  settings
}
