use serde::{Deserialize, Serialize};

use pdf_inspector::{LayoutComplexity, PdfProcessResult, PdfType};

/// Frontend-facing PDF type, serialized as "TextBased" / "Scanned" / ...
#[derive(Debug, Clone, Copy, Serialize)]
pub enum PdfTypeDto {
  TextBased,
  Scanned,
  ImageBased,
  Mixed,
}

impl From<PdfType> for PdfTypeDto {
  fn from(t: PdfType) -> Self {
    match t {
      PdfType::TextBased => Self::TextBased,
      PdfType::Scanned => Self::Scanned,
      PdfType::ImageBased => Self::ImageBased,
      PdfType::Mixed => Self::Mixed,
    }
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutDto {
  pub is_complex: bool,
  pub pages_with_tables: Vec<u32>,
  pub pages_with_columns: Vec<u32>,
}

impl From<&LayoutComplexity> for LayoutDto {
  fn from(l: &LayoutComplexity) -> Self {
    Self {
      is_complex: l.is_complex,
      pages_with_tables: l.pages_with_tables.clone(),
      pages_with_columns: l.pages_with_columns.clone(),
    }
  }
}

/// Detection result shared by both commands.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectResult {
  pub pdf_type: PdfTypeDto,
  pub confidence: f32,
  pub page_count: u32,
  pub pages_needing_ocr: Vec<u32>,
  pub title: Option<String>,
  pub has_encoding_issues: bool,
  pub layout: LayoutDto,
}

impl From<&PdfProcessResult> for DetectResult {
  fn from(r: &PdfProcessResult) -> Self {
    Self {
      pdf_type: r.pdf_type.into(),
      confidence: r.confidence,
      page_count: r.page_count,
      pages_needing_ocr: r.pages_needing_ocr.clone(),
      title: r.title.clone(),
      has_encoding_issues: r.has_encoding_issues,
      layout: LayoutDto::from(&r.layout),
    }
  }
}

/// Full conversion result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertResult {
  #[serde(flatten)]
  pub info: DetectResult,
  pub markdown: String,
  pub processing_time_ms: u64,
}

impl From<&PdfProcessResult> for ConvertResult {
  fn from(r: &PdfProcessResult) -> Self {
    Self {
      info: DetectResult::from(r),
      markdown: r.markdown.clone().unwrap_or_default(),
      processing_time_ms: r.processing_time_ms,
    }
  }
}

/// A model belonging to an OCR vendor. Only a display name is stored; URL
/// and API key live on the vendor.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrModel {
  pub id: String,
  pub name: String,
}

/// Persisted vendor entry. `api_key` holds the *protected* secret
/// (DPAPI-wrapped, hex payload), never the plaintext.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrVendor {
  pub id: String,
  pub name: String,
  pub base_url: String,
  pub api_key: Option<String>,
  pub models: Vec<OcrModel>,
}

impl OcrVendor {
  /// Payload handed to the frontend; never exposes the encrypted secret.
  pub fn to_dto(&self) -> OcrVendorDto {
    OcrVendorDto {
      id: self.id.clone(),
      name: self.name.clone(),
      base_url: self.base_url.clone(),
      api_key_set: self.api_key.is_some(),
      models: self.models.clone(),
    }
  }
}

/// Vendor display payload for the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrVendorDto {
  pub id: String,
  pub name: String,
  pub base_url: String,
  /// Whether a key is already stored (the secret is never sent back).
  pub api_key_set: bool,
  pub models: Vec<OcrModel>,
}

/// Input payload from the settings form when saving.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrVendorInput {
  pub id: String,
  pub name: String,
  pub base_url: String,
  /// New API key to store. Empty string means "keep whatever is stored".
  pub api_key: String,
  /// Set to true to remove the stored key for this vendor.
  pub clear_api_key: bool,
  pub models: Vec<OcrModel>,
}

/// Payload returned by `hybrid_session_start`: the session id plus the same
/// detection info the frontend already knows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HybridSessionInfo {
  pub session_id: String,
  #[serde(flatten)]
  pub info: DetectResult,
}

/// A single GFM (GitHub Flavored Markdown) table parsed from a `.md` file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdTable {
  pub columns: Vec<String>,
  pub rows: Vec<Vec<String>>,
}

/// Analysis of the tables found in a Markdown file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdAnalyzeResult {
  pub table_count: usize,
  pub tables: Vec<MdTable>,
  pub total_rows: usize,
  pub processing_time_ms: u64,
}

/// Result of exporting tables from Markdown to a `.xlsx` workbook.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdExportResult {
  pub table_count: usize,
  pub total_rows: usize,
  pub processing_time_ms: u64,
}

/// Global application settings (persisted in `app-settings.json`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
  /// Max concurrent batch conversions (clamped to 1–16).
  pub max_concurrent: u32,
}

impl Default for AppSettings {
  fn default() -> Self {
    Self { max_concurrent: 1 }
  }
}
