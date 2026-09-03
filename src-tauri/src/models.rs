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
  /// 1-indexed pages that needed OCR but were skipped because no usable OCR
  /// provider is configured. They appear in the markdown as a skip comment.
  pub skipped_pages: Vec<u32>,
  /// 1-indexed pages whose OCR request failed (degraded to a placeholder
  /// comment in the markdown).
  pub failed_pages: Vec<u32>,
  /// Average confidence of the local PaddleOCR results (0..1). `None` when the
  /// conversion used no local OCR (pure text, remote AI vision, or OCR
  /// disabled), since those paths expose no meaningful confidence score.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub ocr_confidence: Option<f32>,
}

impl From<&PdfProcessResult> for ConvertResult {
  fn from(r: &PdfProcessResult) -> Self {
    Self {
      info: DetectResult::from(r),
      markdown: r.markdown.clone().unwrap_or_default(),
      processing_time_ms: r.processing_time_ms,
      skipped_pages: Vec::new(),
      failed_pages: Vec::new(),
      ocr_confidence: None,
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
  /// Whether this is the model used for OCR when its vendor is selected.
  #[serde(default)]
  pub default: bool,
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
  /// Whether a usable OCR provider was resolved for this session. When `false`,
  /// pages that need OCR are skipped (recorded in the finish result).
  pub ocr_configured: bool,
  #[serde(flatten)]
  pub info: DetectResult,
}

/// A single GFM (GitHub Flavored Markdown) table parsed from a `.md` file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdTable {
  pub columns: Vec<String>,
  pub rows: Vec<Vec<String>>,
  /// Source PDF page (1-indexed) when the table came from this app's
  /// PDF>Markdown conversion; `None` for tables without a page marker.
  pub page: Option<u32>,
}

/// Analysis of the tables found in a Markdown file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdAnalyzeResult {
  pub table_count: usize,
  pub tables: Vec<MdTable>,
  pub total_rows: usize,
  /// Total number of lines in the whole file (tables, prose and blanks).
  pub total_lines: usize,
  pub processing_time_ms: u64,
  /// Full raw markdown content of the file, returned so the frontend can show
  /// a rendered/raw markdown preview without reading the file a second time.
  pub content: String,
}

/// Result of exporting tables from Markdown to a `.xlsx` workbook.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdExportResult {
  pub table_count: usize,
  pub total_rows: usize,
  pub processing_time_ms: u64,
}

// ─── Line-draw table extraction types ───────────────────────────────────────

/// A rectangular region in PDF user-space coordinates.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawTableRegion {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

/// A single rectangular region drawn by the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionRect {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

/// Per-page draw-table definition sent from the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDrawTable {
  pub page: u32,
  pub horizontal_lines: Vec<f64>,
  pub vertical_lines: Vec<f64>,
  pub rectangles: Option<Vec<RegionRect>>,
  /// Column indices (0-based, left→right) whose wrapped text lines merge into
  /// one cell in `guided` paragraph mode (00015). Empty = no guided merge on
  /// this page.
  #[serde(default)]
  pub merge_columns: Vec<usize>,
  /// Page origin (x, y of lower-left corner) in PDF points, from pdfjs rawDims.
  pub page_x: f64,
  pub page_y: f64,
  /// Page width/height in PDF points (without userUnit scaling), from pdfjs rawDims.
  pub page_width: f64,
  pub page_height: f64,
}

/// A page rendered to PNG (base64) by the frontend, used as the OCR fallback
/// source when a drawn page has no extractable text layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageImagePayload {
  /// 1-indexed page number.
  pub page: u32,
  /// PNG bytes encoded as base64.
  pub image_png: String,
  /// Scale (pixels per PDF point) at which the PNG was rendered, so backend
  /// pixel coordinates can be mapped back into PDF point space.
  pub render_scale: f64,
}

/// Complete draw-table request payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawTableRequest {
  pub pages: Vec<PageDrawTable>,
  /// When `true`, the lines drawn on one page are applied to every page of the
  /// document instead of only the pages listed in `pages`.
  pub use_for_all_pages: Option<bool>,
  /// When `use_for_all_pages` is `true`, restrict extraction to the first
  /// `max_pages` pages (e.g. a quick preview of the first 5 pages to verify the
  /// drawn lines before extracting the whole document). `None` means all pages.
  pub max_pages: Option<u32>,
  /// Total page count of the document. Only needed for `use_for_all_pages`
  /// extractions of documents without any text layer, where the page count
  /// cannot be derived from extracted text items.
  pub total_pages: Option<u32>,
  /// Restrict processing to these 1-indexed pages. Used by the frontend to
  /// batch large OCR extractions into several requests.
  pub only_pages: Option<Vec<u32>>,
  /// Rendered page images for the local PaddleOCR fallback. Pages with a text
  /// layer never touch these; an image is consumed only when its page has no
  /// extractable text at all.
  pub page_images: Option<Vec<PageImagePayload>>,
  /// Regions whose content must not be recognized. Same payload as the
  /// conversion commands: rects are viewport-relative PDF points, i.e. the
  /// very space `pages[].page_x/page_y` describe, so no extra shift is needed
  /// (see `docs/design/00011_draw-line-exclude-region.md`).
  pub exclusions: Option<ExcludeRegions>,
}

// ─── Exclusion-region types (see docs/design/00010_pdf-exclude-region.md) ──

/// One page's exclusion regions: rectangles whose content must not take part
/// in recognition.
///
/// Rects live in **viewport-relative PDF points with the origin at the
/// lower-left corner** of the pdf.js viewBox - the same space as
/// [`PageDrawTable`] - so the backend shifts them by `(page_x, page_y)` before
/// comparing them against pdf-inspector's absolute user-space coordinates.
/// `rects` being empty means "nothing is excluded on this page", which lets the
/// frontend opt individual pages (e.g. rotated ones) out of an
/// apply-to-all-pages template.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageExclude {
  pub page: u32,
  pub rects: Vec<RegionRect>,
  /// Page origin (x, y of lower-left corner) in PDF points, from pdfjs rawDims.
  pub page_x: f64,
  pub page_y: f64,
  /// Page width/height in PDF points (without userUnit scaling).
  pub page_width: f64,
  pub page_height: f64,
}

/// Complete exclusion payload for one conversion.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludeRegions {
  pub pages: Vec<PageExclude>,
  /// When `true`, the rects of the first page that carries any are applied to
  /// every page of the document instead of only to the listed pages.
  pub use_for_all_pages: Option<bool>,
  /// Total page count. Only needed for `use_for_all_pages` so pages without
  /// their own entry can be expanded.
  pub total_pages: Option<u32>,
}

/// Metadata about where a table was extracted from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRegionInfo {
  pub page: u32,
  pub row_start: f64,
  pub row_end: f64,
  pub col_start: f64,
  pub col_end: f64,
}

/// Result of extracting tables from user-drawn lines.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawTableResult {
  pub table_count: usize,
  pub tables: Vec<MdTable>,
  pub regions: Vec<TableRegionInfo>,
  pub total_rows: usize,
  pub processing_time_ms: u64,
  /// 1-indexed pages whose content came from the local PaddleOCR fallback
  /// (the page had no extractable text layer).
  pub ocr_pages: Vec<u32>,
  /// 1-indexed pages that had no text layer and no usable OCR result - they
  /// were processed but produced nothing.
  pub empty_text_pages: Vec<u32>,
  /// Average confidence (0..1) of the local PaddleOCR fallback across the
  /// pages that went through it. `None` when no page used local OCR (pure
  /// text-layer extraction, remote AI vision, or OCR disabled).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub ocr_confidence: Option<f32>,
}

/// Global application settings (persisted in `app-settings.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
  /// Max concurrent batch conversions (clamped to 1–16).
  pub max_concurrent: u32,
  /// Cache decoded line-draw text items per document, so repeated extractions
  /// reuse the font/CMap + content-stream decode instead of paying for it every
  /// time. Costs memory (one full-document decode stays resident); switch it
  /// off for very large documents.
  #[serde(default = "default_true")]
  pub cache_extracted_text: bool,
  /// Only export the GFM tables when converting Markdown to Excel. When
  /// `false`, the whole document content (tables and plain text) is written
  /// into the workbook.
  #[serde(default = "default_true")]
  pub excel_tables_only: bool,
  /// OCR mode: controls when and how OCR is performed.
  #[serde(default)]
  pub ocr_mode: OcrMode,
  /// Global hotkey that starts screenshot recognition (e.g. `"F8"`).
  /// `None` / empty string disables the hotkey.
  #[serde(default = "default_screenshot_hotkey")]
  pub screenshot_hotkey: Option<String>,
  /// Whether to show the system tray icon.
  #[serde(default = "default_true")]
  pub enable_tray: bool,
  /// Separator between text blocks within a single OCR line.
  /// Supported values: `" "` (space), `","` (comma), `"|"` (pipe),
  /// `"\t"` (tab), `"^"` (caret).
  #[serde(default = "default_text_separator")]
  pub text_separator: String,
  /// Show a popup with the recognized text after every screenshot
  /// recognition (pin / copy / clear actions included).
  #[serde(default = "default_true")]
  pub snip_result_popup: bool,
  /// Copy the screenshot recognition result to the clipboard automatically
  /// as soon as it is ready.
  #[serde(default = "default_true")]
  pub snip_auto_copy: bool,
  /// Glassmorphism background opacity for the snip result window (0–100).
  /// 0 = fully transparent, 100 = fully opaque.
  #[serde(default = "default_snip_result_opacity")]
  pub snip_result_opacity: u32,
  /// Glassmorphism background opacity for the main window (0–100).
  /// 0 = fully transparent, 100 = fully opaque.
  #[serde(default = "default_main_window_opacity")]
  pub main_window_opacity: u32,
  /// Enable the frosted-glass blur effect on the main and result windows.
  /// Default off: acrylic/backdrop blur only kicks in when the user turns it
  /// on; the exclusion panel and the unsaved-changes bar stay blurred via
  /// `glass-blur-always` regardless.
  #[serde(default)]
  pub glass_blur_enabled: bool,
  /// Run the local PaddleOCR engine in MNN low-precision (f16) mode -
  /// roughly 30–50% faster on CPU with negligible accuracy loss.
  #[serde(default = "default_true")]
  pub ocr_low_precision: bool,
  /// Which PaddleOCR model tier the local engine loads.
  #[serde(default)]
  pub ocr_model_size: OcrModelSize,
  /// High-precision draw-table extraction on scanned pages: renders OCR page
  /// images at a higher DPI (~288 vs ~180) and cuts recognized text blocks by
  /// width-weighted character centers instead of a uniform advance. More
  /// accurate column boundaries at the cost of speed and memory.
  #[serde(default = "default_true")]
  pub draw_table_high_precision: bool,
  /// Custom prompt for the remote AI document-OCR path (PDF pages, images,
  /// screenshots). Empty string falls back to the built-in default prompt.
  #[serde(default)]
  pub ai_ocr_prompt: String,
  /// Custom prompt for the remote AI draw-table path (image / PDF line-draw
  /// extraction). Empty string falls back to the built-in default prompt.
  #[serde(default)]
  pub draw_table_prompt: String,
  /// How PDF text pages and OCR pages join visual lines into paragraphs.
  /// `Keep` keeps one Markdown line per visual line (the original behaviour),
  /// `Smart` merges soft line breaks inside a paragraph, `None` merges all
  /// non-structural lines of a page.
  #[serde(default)]
  pub paragraph_mode: ParagraphMode,
  /// Number of inference threads for the local PaddleOCR engine (MNN).
  /// `0` means auto-detect from `available_parallelism` (clamped to 1–16),
  /// matching the pre-setting behaviour. Positive values use the user's choice.
  #[serde(default)]
  pub local_ocr_threads: u32,
  /// Layout analysis applied to local OCR pages (docs/design/00016).
  /// `off` keeps the current behaviour (pure Y→X sorting), `paddle` runs the
  /// selected MNN layout model and falls back to `off` when the model is
  /// missing.
  #[serde(default)]
  pub ocr_layout_mode: LayoutMode,
  /// Selected layout model: the subdirectory name under
  /// `resources/models/layout/` that carries a `model.mnn` +
  /// `layout-meta.json`. Missing / unknown values make `paddle` mode degrade
  /// to `off` (with a notice) instead of failing the conversion.
  #[serde(default = "default_layout_model")]
  pub ocr_layout_model: String,
  /// Confidence threshold (0..1) for Paddle layout detections (PicoDet
  /// recommends 0.5). Only applies to `paddle` mode.
  #[serde(default = "default_layout_score_threshold")]
  pub layout_score_threshold: f32,
  /// Drop `page_header` / `page_footer` regions from the layout output
  /// instead of keeping them as HTML comments. `paddle` mode only.
  #[serde(default = "default_true")]
  pub layout_drop_header_footer: bool,
  /// Normalize raw local OCR output before the paragraph policy: strip
  /// zero-width / BOM characters, collapse in-line whitespace runs (incl.
  /// full-width) to a single space, and normalize CJK ↔ Latin/digit spacing
  /// (docs/design/00017 P1-1). Default on.
  #[serde(default = "default_true")]
  pub ocr_text_cleanup: bool,
  /// Strip inline Markdown syntax (`**bold**`, `` `code` ``, `[text](url)`)
  /// from cells and plain lines when writing Excel (docs/design/00017 P1-2).
  /// Default off: Markdown is written verbatim.
  #[serde(default)]
  pub strip_md_syntax: bool,
  /// Write numeric cells (plain integers / decimals / percentages) as Excel
  /// numbers so they sort and sum. When `false` every cell is a text string;
  /// leading-zero and culturally-formatted values always stay text
  /// (docs/design/00017 P1-3). Default off.
  #[serde(default)]
  pub write_numeric: bool,
}

/// How extracted text lines are joined into paragraphs (PDF text pages and
/// OCR pages share the same policy). Serialized as a lowercase string
/// (`"guided"` / `"smart"` / `"none"`). `Guided` without a merge-column
/// selection keeps one Markdown line per visual line - identical to the
/// removed `Keep` mode, so `"keep"` and unknown values degrade to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", try_from = "String")]
pub enum ParagraphMode {
  /// Guided: only merge the text lines inside the user-selected table columns
  /// that sit between the drawn vertical lines (00015). With no selection it
  /// keeps one Markdown line per visual line (the old `keep` behaviour).
  #[default]
  Guided,
  /// Merge soft line breaks inside a paragraph; keep paragraph boundaries,
  /// tables, lists, headings and code blocks intact.
  Smart,
  /// Merge every line of a page into one (tables and code blocks are still
  /// kept as-is).
  None,
}

impl TryFrom<String> for ParagraphMode {
  type Error = std::convert::Infallible;
  fn try_from(s: String) -> Result<Self, Self::Error> {
    Ok(match s.trim().to_ascii_lowercase().as_str() {
      "smart" | "unwrap" | "paragraph" => Self::Smart,
      "none" | "single" | "nolinebreak" => Self::None,
      // Guided (00015) is the default. A user draws vertical column separators
      // and explicitly picks which columns merge their wrapped text; with no
      // selection it behaves like the removed `keep` (per-line). Unknown /
      // corrupt values and pre-existing `"keep"` configs all fall back here.
      _ => Self::Guided,
    })
  }
}

/// User-specified column merge configuration for `ParagraphMode::Guided`
/// (docs/design/00015_guided-paragraph-mode.md). All quantities are in page
/// pixels; `vertical_lines` is optional because the request may reuse the
/// lines already sent in `ImageTableRequest`.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuidedMergeConfig {
  /// Vertical line x-coordinates (page pixels, ascending). May be empty when
  /// the caller already supplies `vertical_lines` in the request.
  #[serde(default)]
  pub vertical_lines: Vec<f64>,
  /// Record boundaries (y-coordinates, ascending); same semantics as the
  /// horizontal row bands of the draw-table flow. Optional.
  #[serde(default)]
  pub horizontal_lines: Vec<f64>,
  /// Indices (0-based, left→right) of the columns whose wrapped lines must be
  /// merged into one cell. Columns not listed stay line-by-line.
  #[serde(default)]
  pub merge_columns: Vec<usize>,
}

/// Local PaddleOCR model tier. Tiny is the fastest with the lowest accuracy,
/// small is roughly 2–3× faster than medium with slightly lower accuracy;
/// medium prioritizes accuracy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OcrModelSize {
  #[default]
  Small,
  Tiny,
  Medium,
}

/// Layout analysis mode applied to local OCR pages (docs/design/00016).
/// Serialized as a lowercase string (`"off"` / `"paddle"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", try_from = "String")]
pub enum LayoutMode {
  /// No layout analysis - the current Y→X sorted line output, byte-identical
  /// to previous behaviour. Default, zero regression risk.
  #[default]
  Off,
  /// Paddle layout detection model (PicoDet / PP-DocLayoutV3) via MNN. Falls
  /// back to `off` when the selected model directory is missing.
  Paddle,
}

impl TryFrom<String> for LayoutMode {
  type Error = std::convert::Infallible;
  fn try_from(s: String) -> Result<Self, Self::Error> {
    Ok(match s.trim().to_ascii_lowercase().as_str() {
      "paddle" | "model" | "mnn" => Self::Paddle,
      // Unknown / pre-existing configs fall back to off (no behaviour change).
      _ => Self::Off,
    })
  }
}

impl OcrModelSize {
  pub fn as_str(&self) -> &'static str {
    match self {
      Self::Tiny => "tiny",
      Self::Small => "small",
      Self::Medium => "medium",
    }
  }
}

/// Controls when and how OCR is applied during conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OcrMode {
  /// OCR every page using the local PaddleOCR engine.
  ForceLocal,
  /// OCR every page using remote AI vision providers.
  ForceAi,
  /// OCR only non-text pages using the local PaddleOCR engine.
  NonTextLocal,
  /// OCR only non-text pages using remote AI vision providers.
  NonTextAi,
  /// Disable OCR entirely.
  Disabled,
}

impl OcrMode {
  /// Returns true if this mode uses the local engine.
  pub fn is_local(&self) -> bool {
    matches!(self, Self::ForceLocal | Self::NonTextLocal)
  }

  /// Returns true if this mode requires OCR (not disabled).
  pub fn is_enabled(&self) -> bool {
    !matches!(self, Self::Disabled)
  }

  /// Returns true if OCR should be forced on all pages.
  pub fn is_force(&self) -> bool {
    matches!(self, Self::ForceLocal | Self::ForceAi)
  }
}

impl Default for OcrMode {
  fn default() -> Self {
    Self::Disabled
  }
}

/// Result of converting one standalone image to Markdown via OCR.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrImageResult {
  /// The recognized content as GFM Markdown.
  pub markdown: String,
  /// Which engine produced the result: `"local"` or `"ai"`.
  pub engine: String,
  /// Wall-clock duration of the recognition in milliseconds.
  pub duration_ms: u64,
  /// Base64 PNG of the recognized region - only set by the screenshot
  /// pipeline so the frontend can thumbnail without touching disk.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub png_base64: Option<String>,
  /// Path of the saved screenshot copy (screenshot pipeline only), so the
  /// item behaves like a regular imported file for retry / export.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub saved_path: Option<String>,
  /// Stage timing: region crop (+ thumbnail encode), screenshot pipeline
  /// only (docs/design/00005_snip-local-ocr-latency.md S-6).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub crop_ms: Option<u64>,
  /// Stage timing: OCR inference (local det+rec or remote AI round-trip).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub infer_ms: Option<u64>,
  /// Stage timing: full-resolution PNG encode + persist to disk.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub save_ms: Option<u64>,
  /// Average confidence of the local PaddleOCR recognition (0..1). `None` for
  /// the remote AI vision path, which exposes no per-token confidence.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub ocr_confidence: Option<f32>,
}

/// Request to extract a table from an image using drawn lines.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageTableRequest {
  /// Path to the image file on disk.
  pub image_path: String,
  /// Vertical line positions as percentages of the image width (0-100).
  pub vertical_lines: Vec<f64>,
  /// Horizontal line positions as percentages of the image height (0-100).
  /// When present and non-empty, rows are cut at these boundaries instead of
  /// being auto-grouped from OCR block positions; the topmost band is the
  /// header. Absent / empty keeps the legacy auto-detection behavior.
  #[serde(default)]
  pub horizontal_lines: Option<Vec<f64>>,
  /// Optional guided column-merge configuration (multi-column merges from
  /// docs/design/00015). Present only when the user selected the `guided`
  /// paragraph mode and drew vertical lines + picked merge columns.
  #[serde(default)]
  pub guided: Option<GuidedMergeConfig>,
}

/// Result of extracting a table from an image with drawn lines.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageTableResult {
  /// The recognized content as GFM Markdown table(s).
  pub markdown: String,
  /// Which engine produced the result: `"local"` or `"ai"`.
  pub engine: String,
  /// Wall-clock duration of the recognition in milliseconds.
  pub duration_ms: u64,
}

/// One captured monitor snapshot offered to the snip overlay windows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshot {
  /// Stable monitor id used to address the cached snapshot later.
  pub id: u32,
  /// Physical position of the monitor on the desktop.
  pub x: i32,
  pub y: i32,
  /// Physical size of the captured frame.
  pub width: u32,
  pub height: u32,
  /// OS DPI scale factor (`css_px = physical_px / scale`).
  pub scale_factor: f64,
  /// `data:image/png;base64,...` snapshot shown as the overlay background.
  pub data_url: String,
}

/// A user-dragged rectangle inside one monitor, in **physical pixels**
/// relative to that monitor's top-left corner.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotRegion {
  pub monitor_id: u32,
  pub x: i32,
  pub y: i32,
  pub width: u32,
  pub height: u32,
}

/// Information about the top-level window currently under the cursor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
  pub title: String,
  pub class_name: String,
  pub x: i32,
  pub y: i32,
  pub width: i32,
  pub height: i32,
}

// ─── Local usage statistics types ─────────────────────────────────────────

/// What kind of operation produced a usage log entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageKind {
  /// PDF → Markdown conversion (`convert_pdf` or a hybrid session).
  Pdf,
  /// Manual draw-table extraction on a PDF page.
  DrawTable,
  /// Draw-table extraction on an imported image.
  ImageTable,
  /// Single-image → Markdown recognition.
  Image,
  /// Screenshot region recognition.
  Screenshot,
}

/// Usage event submitted by the frontend. The local calendar date is computed
/// in the webview so the backend needs no timezone database (zero new deps).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageInput {
  pub kind: UsageKind,
  /// Files involved (normally 1 - one entry per operation).
  pub file_count: u32,
  /// Pages involved (1 for a single image / screenshot).
  pub page_count: u32,
  /// Pages that actually went through OCR.
  pub ocr_page_count: u32,
  /// OCR engine used: `"local"` (PaddleOCR) or `"ai"` (remote vision).
  /// `None` when no OCR was performed.
  pub engine: Option<String>,
  /// Wall-clock duration of the whole operation in milliseconds.
  pub total_ms: u64,
  /// Local calendar date when the operation happened (`YYYY-MM-DD`).
  pub date: String,
}

/// One persisted line of the append-only usage log (JSONL).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLogEntry {
  pub date: String,
  pub kind: UsageKind,
  pub file_count: u32,
  pub page_count: u32,
  pub ocr_page_count: u32,
  pub engine: Option<String>,
  pub total_ms: u64,
}

impl UsageLogEntry {
  /// `YYYY-MM` bucket derived from `date`.
  pub fn month(&self) -> String {
    self.date.chars().take(7).collect()
  }
}

/// Aggregated counters for one time period.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsagePeriodStats {
  /// Total files (PDF + images combined).
  pub file_count: u32,
  /// Total pages (PDF pages; each image / screenshot counts as 1).
  pub page_count: u32,
  /// Pages that went through OCR (PDF OCR pages + one per image / screenshot).
  pub ocr_page_count: u32,
  /// Total wall-clock time of all operations in milliseconds.
  pub total_ms: u64,
  /// PDF files (kinds `Pdf` / `DrawTable`).
  pub pdf_file_count: u32,
  /// PDF document pages converted or extracted.
  pub pdf_page_count: u32,
  /// PDF pages that went through OCR (the true "scan ratio").
  pub pdf_ocr_page_count: u32,
  /// Image files (kinds `Image` / `Screenshot` / `ImageTable`).
  pub image_file_count: u32,
  /// OCR pages handled by the local PaddleOCR engine.
  pub local_ocr_page_count: u32,
  /// OCR pages handled by the remote AI vision engine.
  pub ai_ocr_page_count: u32,
}

impl UsagePeriodStats {
  pub(crate) fn add(&mut self, entry: &UsageLogEntry) {
    self.file_count = self.file_count.saturating_add(entry.file_count);
    self.page_count = self.page_count.saturating_add(entry.page_count);
    self.ocr_page_count = self.ocr_page_count.saturating_add(entry.ocr_page_count);
    self.total_ms = self.total_ms.saturating_add(entry.total_ms);
    match entry.engine.as_deref() {
      Some("local") => {
        self.local_ocr_page_count = self
          .local_ocr_page_count
          .saturating_add(entry.ocr_page_count);
      }
      Some("ai") => {
        self.ai_ocr_page_count = self.ai_ocr_page_count.saturating_add(entry.ocr_page_count);
      }
      _ => {}
    }
    match entry.kind {
      UsageKind::Pdf | UsageKind::DrawTable => {
        self.pdf_file_count = self.pdf_file_count.saturating_add(entry.file_count);
        self.pdf_page_count = self.pdf_page_count.saturating_add(entry.page_count);
        self.pdf_ocr_page_count = self.pdf_ocr_page_count.saturating_add(entry.ocr_page_count);
      }
      UsageKind::Image | UsageKind::ImageTable | UsageKind::Screenshot => {
        self.image_file_count = self.image_file_count.saturating_add(entry.file_count);
      }
    }
  }
}

/// Read-only aggregate sent to the settings page (`get_usage_stats`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
  /// Current calendar month.
  pub month: UsagePeriodStats,
  /// Today.
  pub today: UsagePeriodStats,
  /// All recorded history.
  pub total: UsagePeriodStats,
}

fn default_true() -> bool {
  true
}

fn default_screenshot_hotkey() -> Option<String> {
  Some("F8".to_string())
}

fn default_text_separator() -> String {
  " ".to_string()
}

fn default_layout_model() -> String {
  "PP-DocLayoutV3".to_string()
}

fn default_layout_score_threshold() -> f32 {
  0.5
}

fn default_snip_result_opacity() -> u32 {
  60
}

fn default_main_window_opacity() -> u32 {
  100
}

impl Default for AppSettings {
  fn default() -> Self {
    Self {
      max_concurrent: 1,
      cache_extracted_text: true,
      excel_tables_only: false,
      ocr_mode: OcrMode::default(),
      screenshot_hotkey: default_screenshot_hotkey(),
      enable_tray: true,
      text_separator: default_text_separator(),
      snip_result_popup: true,
      snip_auto_copy: true,
      snip_result_opacity: 60,
      main_window_opacity: 100,
      glass_blur_enabled: false,
      ocr_low_precision: true,
      ocr_model_size: OcrModelSize::default(),
      draw_table_high_precision: true,
      ai_ocr_prompt: String::new(),
      draw_table_prompt: String::new(),
      paragraph_mode: ParagraphMode::default(),
      local_ocr_threads: 0,
      ocr_layout_mode: LayoutMode::default(),
      ocr_layout_model: default_layout_model(),
      layout_score_threshold: default_layout_score_threshold(),
      layout_drop_header_footer: true,
      ocr_text_cleanup: true,
      strip_md_syntax: false,
      write_numeric: false,
    }
  }
}
