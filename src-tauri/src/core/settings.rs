use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::core::secret;
use crate::models::{AppSettings, OcrVendor, OcrVendorInput};

const CONFIG_FILE: &str = "ocr-config.json";
const APP_SETTINGS_FILE: &str = "app-settings.json";
const MAX_CONCURRENT_LIMIT: u32 = 16;

fn app_config_file(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_config_dir()
    .map_err(|e| format!("无法获取配置目录: {e}"))?;
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

/// Persist vendors, merging secrets:
/// - `clear_api_key` empties the stored key.
/// - otherwise an empty `api_key` keeps the previously stored secret.
/// - otherwise the new key is protected and stored.
pub fn save_ocr_config(app: &AppHandle, inputs: Vec<OcrVendorInput>) -> Result<(), String> {
  let path = config_path(app)?;
  let mut vendors = load_vendors(&path);

  for input in inputs {
    let key = if input.clear_api_key {
      None
    } else if input.api_key.trim().is_empty() {
      vendors
        .iter()
        .find(|v| v.id == input.id)
        .and_then(|v| v.api_key.clone())
    } else {
      Some(secret::protect(input.api_key.trim())?)
    };

    let merged = OcrVendor {
      id: input.id.clone(),
      name: input.name,
      base_url: input.base_url,
      api_key: key,
      models: input.models,
    };

    if let Some(existing) = vendors.iter_mut().find(|v| v.id == merged.id) {
      *existing = merged;
    } else {
      vendors.push(merged);
    }
  }

  let dir = path.parent().ok_or_else(|| "配置目录无效".to_string())?;
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
  let dir = path.parent().ok_or_else(|| "配置目录无效".to_string())?;
  std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  let json = serde_json::to_string_pretty(&clamp_settings(settings)).map_err(|e| e.to_string())?;
  std::fs::write(&path, json).map_err(|e| e.to_string())?;
  Ok(())
}

fn clamp_settings(mut settings: AppSettings) -> AppSettings {
  settings.max_concurrent = settings.max_concurrent.clamp(1, MAX_CONCURRENT_LIMIT);
  settings
}
