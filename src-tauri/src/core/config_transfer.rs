//! Configuration import / export (app settings + OCR vendors).
//!
//! Exported files are self-contained JSON documents:
//!
//! ```json
//! {
//!   "version": 1,
//!   "app": "DocCraft",
//!   "exportedAtMs": 1755900000000,
//!   "includeSecrets": false,
//!   "ocrVendors": [ ... ],
//!   "appSettings": { ... }
//! }
//! ```
//!
//! Secrets are excluded by default. When `includeSecrets` is on, keys are
//! decrypted and written as **plaintext** - the user is warned in the UI.
//! On import, plaintext keys are re-protected through the normal pipeline
//! (`secret::protect`), so a file from another machine just works.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::core::secret;
use crate::core::settings;
use crate::models::{AppSettings, OcrModel, OcrVendorInput};

const EXPORT_VERSION: u32 = 1;
const EXPORT_APP: &str = "DocCraft";

/// One vendor entry as stored inside an export / import file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferVendor {
  pub id: String,
  pub name: String,
  #[serde(default)]
  pub base_url: String,
  /// Plaintext API key - only present when the export included secrets.
  #[serde(default)]
  pub api_key: Option<String>,
  /// Whether a key was configured at export time (even when not exported).
  #[serde(default)]
  pub has_api_key: bool,
  #[serde(default)]
  pub models: Vec<OcrModel>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigFile<'a> {
  version: u32,
  app: &'static str,
  exported_at_ms: u128,
  include_secrets: bool,
  ocr_vendors: &'a [TransferVendor],
  app_settings: &'a AppSettings,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedConfig {
  version: Option<u32>,
  app: Option<String>,
  pub ocr_vendors: Option<Vec<TransferVendor>>,
  pub app_settings: Option<AppSettings>,
}

/// Summary of an import, surfaced to the frontend for the success toast.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
  pub vendors_imported: usize,
  pub settings_applied: bool,
}

/// Build the export document and write it to `path`.
pub fn export_config(app: &AppHandle, path: &str, include_secrets: bool) -> Result<usize, String> {
  let settings = settings::get_app_settings(app)?;
  let vendors = settings::get_ocr_config(app)?;

  let transfer: Vec<TransferVendor> = vendors
    .iter()
    .map(|v| TransferVendor {
      id: v.id.clone(),
      name: v.name.clone(),
      base_url: v.base_url.clone(),
      api_key: if include_secrets {
        v.api_key.as_deref().and_then(secret::unprotect)
      } else {
        None
      },
      has_api_key: v.api_key.is_some(),
      models: v.models.clone(),
    })
    .collect();

  let exported_at_ms = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis())
    .unwrap_or(0);

  // `ocr_vendors` borrows `transfer`; keep them in one place so serde can
  // serialize both fields of the wrapper without cloning the vendors again.
  let doc = ConfigFile {
    version: EXPORT_VERSION,
    app: EXPORT_APP,
    exported_at_ms,
    include_secrets,
    ocr_vendors: &transfer,
    app_settings: &settings,
  };
  let json = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
  std::fs::write(path, json).map_err(|e| e.to_string())?;
  Ok(transfer.len())
}

/// Parse an export file. Validation is structural only - unknown fields are
/// ignored so future versions stay forward-compatible where possible.
pub fn parse_import(path: &str) -> Result<ImportedConfig, String> {
  let text =
    std::fs::read_to_string(path).map_err(|e| format!("Failed to read configuration file: {e}"))?;
  let config: ImportedConfig =
    serde_json::from_str(&text).map_err(|e| format!("Invalid configuration file: {e}"))?;
  if config.app.as_deref().is_some_and(|a| a != EXPORT_APP) {
    return Err("This file was not exported by DocCraft".to_string());
  }
  if let Some(v) = config.version {
    if v > EXPORT_VERSION {
      return Err(format!(
        "Configuration version {v} is newer than this app supports ({EXPORT_VERSION})"
      ));
    }
  }
  if config.ocr_vendors.is_none() && config.app_settings.is_none() {
    return Err("Configuration file contains nothing to import".to_string());
  }
  Ok(config)
}

/// Merge imported vendors into the persisted list (upsert by id; local
/// vendors absent from the import are kept). Returns how many imported
/// entries were applied.
pub fn merge_vendors(app: &AppHandle, imported: Vec<TransferVendor>) -> Result<usize, String> {
  let existing = settings::get_ocr_config(app)?;
  let mut inputs: Vec<OcrVendorInput> = existing
    .into_iter()
    .map(|v| OcrVendorInput {
      id: v.id,
      name: v.name,
      base_url: v.base_url,
      api_key: String::new(), // keep whatever secret is already stored
      clear_api_key: false,
      models: v.models,
    })
    .collect();

  for vendor in &imported {
    let key = vendor.api_key.clone().unwrap_or_default();
    match inputs.iter_mut().find(|i| i.id == vendor.id) {
      Some(entry) => {
        entry.name = vendor.name.clone();
        entry.base_url = vendor.base_url.clone();
        entry.models = vendor.models.clone();
        // Only overwrite the local secret when the file carries a
        // plaintext one; an export without secrets keeps the stored key.
        if !key.is_empty() {
          entry.api_key = key;
        }
      }
      None => inputs.push(OcrVendorInput {
        id: vendor.id.clone(),
        name: vendor.name.clone(),
        base_url: vendor.base_url.clone(),
        api_key: key,
        clear_api_key: false,
        models: vendor.models.clone(),
      }),
    }
  }

  let count = imported.len();
  settings::save_ocr_config(app, inputs)?;
  Ok(count)
}
