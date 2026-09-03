//! Local OCR layout analysis (docs/design/00016_local-ocr-layout-analysis.md).
//!
//! Turns a page of OCR blocks into reading-order regions so multi-column
//! documents stop interleaving, headings gain levels, and page header /
//! footer / seal noise can be filtered.
//!
//! Provided pieces:
//! - [`LayoutClass`]: the processing buckets every layout source maps into
//!   (Title / Text / Table / Figure / Header / Footer / Seal / Other).
//! - Model discovery under `resources/models/layout/<model>/`: each model
//!   directory carries `model.mnn` + `layout-meta.json`; dropping a new
//!   converted model in makes it appear in the settings select without code
//!   changes (design §3.1 / §3.3).
//! - [`LayoutEngine`]: the `paddle` mode — PicoDet / PP-DocLayoutV3 inference
//!   through `ocr_rs::InferenceEngine` (the same MNN runtime as det/rec, so no
//!   second inference dependency) or the vendored DETR binding (`cpp/mnn`).
//! - [`sort_reading_order`]: recursive XY-Cut used to restore reading order.
//! - [`assemble_markdown`]: regions + OCR blocks → Markdown.

use std::collections::HashMap;
use std::ffi::CStr;
use std::os::raw::c_char;
use std::path::{Path, PathBuf};

use image::DynamicImage;
use ndarray::Array4;
use ocr_rs::{InferenceConfig, InferenceEngine, PrecisionMode};
use serde::{Deserialize, Serialize};

use crate::core::get_resources_dir;
use crate::core::ocr::OcrBlock;

// ─── Standalone MNN binding for PP-DocLayoutV3 (DETR) ─────────────────────
//
// The vendored wrapper (`cpp/mnn/mnn_v3_wrapper.cpp`, built by `build.rs`)
// selects the `image` input by name and feeds neutral `im_shape` / `scale_factor`
// defaults.
// It emits three outputs: `fetch_name_0` = `[N, 7]` detections
// (`[class_id, score, x1, y1, x2, y2, reading_order]`), `fetch_name_1` = `[1]`
// count, and `fetch_name_2` = `[N, 200, 2]` multi-point polygons. We consume
// only `fetch_name_0`.
#[repr(C)]
struct V3Ctx {
  _private: [u8; 0],
}

unsafe extern "C" {
  fn mnnv3_create(buffer: *const u8, size: usize, threads: i32, precision: i32) -> *mut V3Ctx;
  fn mnnv3_destroy(e: *mut V3Ctx);
  fn mnnv3_last_error(e: *mut V3Ctx) -> *const c_char;
  fn mnnv3_run(e: *mut V3Ctx, image: *const f32, w: usize, h: usize) -> i32;
  fn mnnv3_output_data(e: *mut V3Ctx, len: *mut usize) -> *const f32;
  fn mnnv3_output_shape(e: *mut V3Ctx, dims: *mut usize, ndims: *mut usize);
}

/// Owning handle to the DETR layout model (PP-DocLayoutV3) running on MNN.
struct V3Engine {
  ptr: *mut V3Ctx,
}

// MNN CPU inference is thread-aware; exposing the engine across threads mirrors
// `ocr_rs::InferenceEngine`'s own `Send + Sync`.
unsafe impl Send for V3Engine {}
unsafe impl Sync for V3Engine {}

impl Drop for V3Engine {
  fn drop(&mut self) {
    unsafe {
      mnnv3_destroy(self.ptr);
    }
  }
}

impl V3Engine {
  fn new(model_path: &Path, threads: i32, low_precision: bool) -> Result<Self, String> {
    let buffer = std::fs::read(model_path).map_err(|e| {
      format!(
        "Failed to read PP-DocLayoutV3 model {}: {e}",
        model_path.display()
      )
    })?;
    let precision = if low_precision { 1 } else { 0 };
    let ptr = unsafe { mnnv3_create(buffer.as_ptr(), buffer.len(), threads, precision) };
    if ptr.is_null() {
      return Err("PP-DocLayoutV3: failed to create MNN engine".to_string());
    }
    Ok(V3Engine { ptr })
  }

  fn last_error(&self) -> String {
    unsafe {
      let p = mnnv3_last_error(self.ptr);
      if p.is_null() {
        "unknown V3 error".to_string()
      } else {
        CStr::from_ptr(p).to_string_lossy().into_owned()
      }
    }
  }

  /// Run the DETR model and decode `[N, 7]` into layout regions. Coordinates
  /// from `fetch_name_0` live in the resized 800x800 input space; they are
  /// mapped back with the model's `keep_ratio` resize convention, then the
  /// regions are ordered by the model's predicted reading order (column 6).
  fn detect(
    &self,
    image: &DynamicImage,
    meta: &LayoutModelMeta,
    score_threshold: f32,
  ) -> Result<Vec<LayoutRegion>, String> {
    let (in_w, in_h) = (meta.input_width as f64, meta.input_height as f64);
    if in_w == 0.0 || in_h == 0.0 {
      return Err("PP-DocLayoutV3: input size is unset".to_string());
    }
    let mut input = preprocess_layout_image(image, meta, in_w, in_h)?;
    let (w, h) = (in_w as usize, in_h as usize);
    let data = input
      .as_slice_mut()
      .ok_or_else(|| "V3 input tensor not contiguous".to_string())?;

    let rc = unsafe { mnnv3_run(self.ptr, data.as_ptr(), w, h) };
    if rc != 0 {
      return Err(format!(
        "PP-DocLayoutV3 inference failed: {}",
        self.last_error()
      ));
    }

    let mut dims = [0usize; 8];
    let mut nd = 0usize;
    unsafe {
      mnnv3_output_shape(self.ptr, dims.as_mut_ptr(), &mut nd);
    }
    if nd < 2 || dims[nd - 1] != 7 {
      return Err(format!(
        "Unexpected PP-DocLayoutV3 output shape {:?} (expected [N, 7])",
        &dims[..nd.min(8)]
      ));
    }
    let rows = dims[nd - 2];
    let mut len = 0usize;
    let pd = unsafe { mnnv3_output_data(self.ptr, &mut len) };
    if pd.is_null() {
      return Err("PP-DocLayoutV3 produced no output data".to_string());
    }
    let slice = unsafe { std::slice::from_raw_parts(pd, len) };
    let orig_w = image.width() as f64;
    let orig_h = image.height() as f64;
    decode_detr_rows(
      slice,
      rows,
      meta,
      score_threshold,
      orig_w,
      orig_h,
      in_w,
      in_h,
    )
  }
}

/// Decode the DETR `[N, 7]` output into layout regions. Each row is
/// `[class_id, score, x1, y1, x2, y2, reading_order]` in the resized input
/// space. Coordinates are mapped back with the model's resize convention and
/// the regions are returned in the model's predicted reading order, then
/// de-duplicated by NMS.
fn decode_detr_rows(
  data: &[f32],
  rows: usize,
  meta: &LayoutModelMeta,
  score_threshold: f32,
  orig_w: f64,
  orig_h: f64,
  in_w: f64,
  in_h: f64,
) -> Result<Vec<LayoutRegion>, String> {
  if data.len() < rows * 7 {
    return Err(format!(
      "PP-DocLayoutV3 output too small: {} bytes for {} rows of 7",
      data.len(),
      rows
    ));
  }
  let map = |mx: f64, my: f64| map_model_point(mx, my, orig_w, orig_h, in_w, in_h, meta.keep_ratio);
  // Candidates carry (reading_order, region).
  let mut candidates: Vec<(f64, LayoutRegion)> = Vec::new();
  for r in 0..rows {
    let base = r * 7;
    let class_id = data[base] as usize;
    let score = data[base + 1];
    if !(score >= score_threshold) {
      continue;
    }
    let (x1, y1) = map(data[base + 2] as f64, data[base + 3] as f64);
    let (x2, y2) = map(data[base + 4] as f64, data[base + 5] as f64);
    if x2 <= x1 || y2 <= y1 {
      continue;
    }
    candidates.push((
      data[base + 6] as f64,
      LayoutRegion {
        class: meta.class_bucket(class_id),
        rect: LayoutRect {
          x: x1,
          y: y1,
          width: x2 - x1,
          height: y2 - y1,
        },
        score: score as f64,
      },
    ));
  }
  if candidates.is_empty() {
    return Ok(Vec::new());
  }
  // Greedy NMS by confidence, keeping the reading-order association.
  candidates.sort_by(|a, b| {
    b.1
      .score
      .partial_cmp(&a.1.score)
      .unwrap_or(std::cmp::Ordering::Equal)
  });
  let mut keep: Vec<(f64, LayoutRegion)> = Vec::new();
  for (order, region) in candidates {
    if keep.iter().any(|(_, k)| iou(k.rect, region.rect) > 0.5) {
      continue;
    }
    keep.push((order, region));
  }
  // Emit in the model's predicted reading order.
  keep.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
  Ok(keep.into_iter().map(|(_, r)| r).collect())
}

/// A gutter narrower than this fraction of the page width is not a split.
const MIN_GAP_RATIO: f64 = 0.02;
/// Absolute minimum XY-Cut gap, in page pixels.
const MIN_GAP_PX: f64 = 12.0;
/// A horizontal gap wider than this fraction of the page width separates two
/// table / column cells within one OCR line.
const COLUMN_GAP_RATIO: f64 = 0.02;
/// Absolute minimum horizontal gap (px) that splits cells in a line.
const COLUMN_GAP_MIN_PX: f64 = 12.0;
/// A region is treated as a table only when its OCR grid has at least this
/// many rows and columns (guards against turning plain prose into a table).
const TABLE_MIN_ROWS: usize = 2;
const TABLE_MIN_COLUMNS: usize = 2;

/// Processing bucket for a layout region. Every model's class table is mapped
/// into these buckets through its `layout-meta.json`; classes that match none
/// of them fall into [`LayoutClass::Other`] and are treated as body text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayoutClass {
  /// Document / paragraph headings → Markdown `#` / `##` / `###`.
  Title,
  /// Body paragraphs, abstracts, footnotes, references...
  Text,
  /// Table areas → emit their text lines + a "draw lines to extract" hint.
  Table,
  /// Figures / charts / images → placeholder, no OCR noise.
  Figure,
  /// Page header band.
  Header,
  /// Page footer band.
  Footer,
  /// Seals / stamps / watermarks → dropped.
  Seal,
  /// Anything else - treated as body text.
  Other,
}

impl LayoutClass {
  /// Map a (lowercased) class name - either a raw model class or a bucket
  /// label from `layout-meta.json` - to a processing bucket.
  pub fn parse(name: &str) -> Self {
    match name.trim().to_ascii_lowercase().as_str() {
      "title" | "doc_title" | "document_title" | "paragraph_title" | "chapter_title"
      | "section_title" | "headline" => Self::Title,
      "text" | "abstract" | "content" | "footnote" | "reference" | "list" | "number"
      | "formula" | "algorithm" | "author" | "affiliation" | "date" | "equipment" | "paragraph"
      | "body" => Self::Text,
      "table" | "form" | "table_caption" => Self::Table,
      "figure" | "chart" | "image" | "picture" | "plot" | "figure_caption" => Self::Figure,
      "header" | "page_header" | "running_header" | "header_footer" => Self::Header,
      "footer" | "page_footer" | "page_number" => Self::Footer,
      "seal" | "stamp" | "watermark" | "noise" => Self::Seal,
      _ => Self::Other,
    }
  }

  pub fn as_str(self) -> &'static str {
    match self {
      Self::Title => "title",
      Self::Text => "text",
      Self::Table => "table",
      Self::Figure => "figure",
      Self::Header => "header",
      Self::Footer => "footer",
      Self::Seal => "seal",
      Self::Other => "other",
    }
  }
}

/// An axis-aligned rectangle in page pixel space (origin at top-left).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayoutRect {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

impl LayoutRect {
  pub fn right(self) -> f64 {
    self.x + self.width
  }
  pub fn bottom(self) -> f64 {
    self.y + self.height
  }
  pub fn center(self) -> (f64, f64) {
    (self.x + self.width * 0.5, self.y + self.height * 0.5)
  }
  pub fn contains(self, px: f64, py: f64) -> bool {
    px >= self.x && px <= self.right() && py >= self.y && py <= self.bottom()
  }
  pub fn area(self) -> f64 {
    self.width * self.height
  }
}

/// One detected layout region.
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutRegion {
  pub class: LayoutClass,
  pub rect: LayoutRect,
  pub score: f64,
}

// ─── Model discovery & metadata ──────────────────────────────────────────

/// Default resource location of the layout model pool:
/// `<resources>/models/layout/<model-dir>/model.mnn + layout-meta.json`.
pub fn layout_models_dir() -> PathBuf {
  get_resources_dir().join("models").join("layout")
}

/// Metadata of one layout model (design §3.1 / §3.3). Every difference
/// between the pool's models (input size, normalization, class table, bucket
/// mapping) is declared here, so switching / adding models never changes the
/// engine code.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LayoutModelMeta {
  /// Stable model name (= directory name). Falls back to `display_name`.
  pub name: String,
  /// Human-readable name shown in the settings select.
  pub display_name: String,
  /// Model file name inside the model directory. Defaults to `model.mnn`;
  /// bundled models may ship under their own name and declare it here.
  pub model_file: String,
  /// Fixed input width / height of the converted MNN model. `0` means "read
  /// from the model itself at load time" (recommended - no guessing).
  pub input_width: u32,
  pub input_height: u32,
  /// Resize strategy. `false` (PaddleX PicoDet convention) stretches the image
  /// to the input size; `true` keeps the aspect ratio and letterbox-pads.
  /// Must match how the model was converted (see its `config.json`).
  pub keep_ratio: bool,
  /// Per-channel RGB mean / std for normalization.
  pub mean: [f32; 3],
  pub std: [f32; 3],
  /// Inference engine flavor: `"detr"` selects the standalone MNN binding
  /// (PP-DocLayoutV3, `[N,7]` output with reading order); `null`/`"picodet"`
  /// uses the `ocr_rs` rows-of-6 engine.
  pub engine: Option<String>,
  /// Model-agnostic detection threshold override (settings win when set).
  pub score_threshold: f32,
  /// Class table in class-id order (index = class id). The order MUST match
  /// the converted model's output; correct it here if a model classifies
  /// wrongly (see resources/models/layout/README.md).
  pub classes: Vec<String>,
  /// Class name → bucket label mapping. Classes absent here are mapped via
  /// [`LayoutClass::parse`] and land in `Other` when unrecognized.
  pub bucket_map: HashMap<String, String>,
}

impl Default for LayoutModelMeta {
  fn default() -> Self {
    Self {
      name: String::new(),
      display_name: String::new(),
      model_file: "model.mnn".to_string(),
      input_width: 0,
      input_height: 0,
      keep_ratio: false,
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225],
      engine: None,
      score_threshold: 0.5,
      classes: Vec::new(),
      bucket_map: HashMap::new(),
    }
  }
}

impl LayoutModelMeta {
  pub fn load(path: &Path) -> Result<Self, String> {
    let text = std::fs::read_to_string(path)
      .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    serde_json::from_str(&text)
      .map_err(|e| format!("Invalid layout-meta.json {}: {e}", path.display()))
  }

  /// Map a class id to its processing bucket using the model's own mapping.
  pub fn class_bucket(&self, class_id: usize) -> LayoutClass {
    let name = self.classes.get(class_id).map(String::as_str).unwrap_or("");
    if let Some(bucket) = self.bucket_map.get(name) {
      return LayoutClass::parse(bucket);
    }
    LayoutClass::parse(name)
  }

  /// Distinct buckets this model can emit, in canonical [`LayoutClass`] order
  /// (excluding `Other`, which everything unmapped falls into). Derived from
  /// the full class table so the settings hint reflects the whole model.
  pub fn bucket_capabilities(&self) -> Vec<&'static str> {
    let mut present = [false; 8];
    for class in &self.classes {
      if let Some(idx) = canonical_index(LayoutClass::parse(class)) {
        present[idx] = true;
      }
    }
    canonical_order()
      .iter()
      .enumerate()
      .filter(|(i, _)| present[*i])
      .map(|(_, label)| *label)
      .collect()
  }
}

/// Canonical bucket order: [`LayoutClass`] declaration order minus `Other`.
fn canonical_order() -> [&'static str; 7] {
  [
    LayoutClass::Title.as_str(),
    LayoutClass::Text.as_str(),
    LayoutClass::Table.as_str(),
    LayoutClass::Figure.as_str(),
    LayoutClass::Header.as_str(),
    LayoutClass::Footer.as_str(),
    LayoutClass::Seal.as_str(),
  ]
}

/// Index of a bucket in [`canonical_order`]; `None` for `Other`.
fn canonical_index(class: LayoutClass) -> Option<usize> {
  canonical_order()
    .iter()
    .position(|label| *label == class.as_str())
}

/// Layout model entry handed to the settings page (`list_layout_models`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutModelInfo {
  /// Subdirectory name under `models/layout/` (= the setting value).
  pub dir: String,
  pub display_name: String,
  pub class_count: usize,
  /// Processing buckets the model can emit (for the settings hint).
  pub buckets: Vec<String>,
  /// `false` when the directory lacks a usable `model.mnn`; `paddle` mode
  /// degrades to `rule` for such models.
  pub available: bool,
}

/// Scan `resources/models/layout/` for model directories. Each directory must
/// carry a parseable `layout-meta.json`; a missing `model.mnn` only marks the
/// entry as unavailable so the select still shows it.
pub fn list_layout_models() -> Vec<LayoutModelInfo> {
  let base = layout_models_dir();
  let Ok(entries) = std::fs::read_dir(&base) else {
    return Vec::new();
  };
  let mut out = Vec::new();
  for entry in entries.flatten() {
    let dir_path = entry.path();
    if !dir_path.is_dir() {
      continue;
    }
    let dir = entry.file_name().to_string_lossy().into_owned();
    let Ok(meta) = LayoutModelMeta::load(&dir_path.join("layout-meta.json")) else {
      continue;
    };
    let display_name = if meta.display_name.is_empty() {
      meta.name.clone()
    } else {
      meta.display_name.clone()
    };
    let model_path = dir_path.join(&meta.model_file);
    out.push(LayoutModelInfo {
      dir,
      display_name,
      class_count: meta.classes.len(),
      buckets: meta
        .bucket_capabilities()
        .into_iter()
        .map(str::to_owned)
        .collect(),
      available: model_path.is_file(),
    });
  }
  out.sort_by(|a, b| a.dir.cmp(&b.dir));
  out
}

/// Resolve a model directory by its setting value. `None` when the directory
/// (or its declared model file) is missing - callers degrade to `rule` mode.
pub fn find_layout_model_dir(model_name: &str) -> Option<PathBuf> {
  let dir = layout_models_dir().join(model_name);
  let meta = LayoutModelMeta::load(&dir.join("layout-meta.json")).ok()?;
  if dir.join(&meta.model_file).is_file() {
    Some(dir)
  } else {
    None
  }
}

// ─── Paddle mode: LayoutEngine ───────────────────────────────────────────

/// Resize `image` to `(w, h)` keeping the aspect ratio (the caller computed
/// the target size from the same ratio, so this is effectively lossless).
fn resize_keep_aspect(image: &DynamicImage, w: u32, h: u32) -> DynamicImage {
  image.resize_exact(w.max(1), h.max(1), image::imageops::FilterType::Triangle)
}

/// Resize the image to the model's input size and normalize with the model's
/// own mean/std into an NCHW tensor `[1, 3, H, W]`. The resize strategy
/// follows the model's `config.json` (`Preprocess[].Resize.keep_ratio`):
/// `keep_ratio = true` letterbox-pads (aspect preserved), otherwise the image
/// is stretched to the exact input size (PaddleX PicoDet default).
fn preprocess_layout_image(
  image: &DynamicImage,
  meta: &LayoutModelMeta,
  in_w: f64,
  in_h: f64,
) -> Result<Array4<f32>, String> {
  let (in_w, in_h) = (in_w as usize, in_h as usize);
  if in_w == 0 || in_h == 0 {
    return Err("layout model input size is unknown".to_string());
  }
  let (rgb, valid_w, valid_h, offset_x, offset_y) = if meta.keep_ratio {
    let (orig_w, orig_h) = (image.width() as f64, image.height() as f64);
    let scale = (in_w as f64 / orig_w).min(in_h as f64 / orig_h);
    let new_w = (orig_w * scale).round().max(1.0) as u32;
    let new_h = (orig_h * scale).round().max(1.0) as u32;
    let resized = resize_keep_aspect(image, new_w, new_h);
    let (rw, rh) = (resized.width() as usize, resized.height() as usize);
    (
      resized.to_rgb8(),
      rw,
      rh,
      (in_w.saturating_sub(rw)) / 2,
      (in_h.saturating_sub(rh)) / 2,
    )
  } else {
    let resized = image.resize_exact(
      in_w as u32,
      in_h as u32,
      image::imageops::FilterType::Triangle,
    );
    let rgb = resized.to_rgb8();
    (rgb, in_w, in_h, 0, 0)
  };

  let mut input = Array4::<f32>::zeros((1, 3, in_h, in_w));
  let plane = in_h * in_w;
  let data = input
    .as_slice_mut()
    .ok_or_else(|| "input tensor not contiguous".to_string())?;

  for y in 0..valid_h {
    let src = &rgb.as_raw()[y * valid_w * 3..(y + 1) * valid_w * 3];
    let dst_row = (offset_y + y) * in_w + offset_x;
    for (x, pixel) in src.chunks_exact(3).enumerate() {
      let dst = dst_row + x;
      data[dst] = (pixel[0] as f32 / 255.0 - meta.mean[0]) / meta.std[0];
      data[plane + dst] = (pixel[1] as f32 / 255.0 - meta.mean[1]) / meta.std[1];
      data[plane * 2 + dst] = (pixel[2] as f32 / 255.0 - meta.mean[2]) / meta.std[2];
    }
  }
  Ok(input)
}

/// Map one model-space point back to the original image, depending on the
/// resize mode:
/// - `keep_ratio` (letterbox): the point is relative to the padded input;
///   subtract the centred offset and divide by the uniform scale factor.
/// - stretch (PaddleX PicoDet default): per-axis scale from the input size.
fn map_model_point(
  mx: f64,
  my: f64,
  orig_w: f64,
  orig_h: f64,
  in_w: f64,
  in_h: f64,
  keep_ratio: bool,
) -> (f64, f64) {
  if keep_ratio {
    let scale = (in_w / orig_w).min(in_h / orig_h);
    let pad_x = (in_w - orig_w * scale) / 2.0;
    let pad_y = (in_h - orig_h * scale) / 2.0;
    (
      ((mx - pad_x) / scale).clamp(0.0, orig_w),
      ((my - pad_y) / scale).clamp(0.0, orig_h),
    )
  } else {
    (mx * orig_w / in_w, my * orig_h / in_h)
  }
}

/// IoU of two rects (for the defensive NMS pass).
fn iou(a: LayoutRect, b: LayoutRect) -> f64 {
  let ix = (a.right().min(b.right()) - a.x.max(b.x)).max(0.0);
  let iy = (a.bottom().min(b.bottom()) - a.y.max(b.y)).max(0.0);
  let inter = ix * iy;
  let union = a.area() + b.area() - inter;
  if union <= 0.0 { 0.0 } else { inter / union }
}

/// Remove near-duplicate detections (score-descending greedy NMS). PicoDet
/// exports usually already bake NMS in; this keeps the list clean regardless.
fn nms(regions: Vec<LayoutRegion>) -> Vec<LayoutRegion> {
  let mut sorted = regions;
  sorted.sort_by(|a, b| {
    b.score
      .partial_cmp(&a.score)
      .unwrap_or(std::cmp::Ordering::Equal)
  });
  let mut keep: Vec<LayoutRegion> = Vec::new();
  for r in sorted {
    if keep.iter().any(|k| iou(k.rect, r.rect) > 0.5) {
      continue;
    }
    keep.push(r);
  }
  keep
}

/// The `paddle` mode engine: PicoDet layout detection through the same MNN
/// runtime that runs det/rec (design §3.3).
pub struct LayoutEngine {
  engine: Option<InferenceEngine>,
  meta: LayoutModelMeta,
  score_threshold: f32,
  /// Resolved input size (width, height) for the PicoDet engine path. Taken
  /// from the meta, or read from the model's own input shape when the meta
  /// leaves it unset.
  input_size: (u32, u32),
  /// Present only for DETR models (`meta.engine == "detr"`, e.g. PP-DocLayoutV3).
  v3: Option<V3Engine>,
}

impl LayoutEngine {
  /// Load a layout model directory (must contain its declared model file +
  /// `layout-meta.json`). `threads` and `low_precision` mirror the OCR engine
  /// settings so the layout model follows the same CPU / fp16 policy.
  pub fn new(
    model_dir: &Path,
    threads: i32,
    low_precision: bool,
    score_threshold: f32,
  ) -> Result<Self, String> {
    let meta = LayoutModelMeta::load(&model_dir.join("layout-meta.json"))?;
    let model_path = model_dir.join(&meta.model_file);
    if !model_path.is_file() {
      return Err(format!(
        "Layout model file missing: {}\nPlease place the converted model in the layout model directory.",
        model_path.display()
      ));
    }

    // DETR models (PP-DocLayoutV3) use the standalone MNN binding instead of
    // `ocr_rs`, since their output is `[N,7]` rather than rows-of-6 and their
    // graph needs the `image` input selected by name.
    if meta.engine.as_deref() == Some("detr") {
      if meta.input_width == 0 || meta.input_height == 0 {
        return Err(
          "PP-DocLayoutV3 requires inputWidth/inputHeight in layout-meta.json".to_string(),
        );
      }
      let v3 = V3Engine::new(&model_path, threads, low_precision)?;
      let input_size = (meta.input_width, meta.input_height);
      return Ok(Self {
        engine: None,
        meta,
        score_threshold,
        input_size,
        v3: Some(v3),
      });
    }

    let mut config = InferenceConfig::new().with_threads(threads);
    if low_precision {
      config = config.with_precision(PrecisionMode::Low);
    }
    let engine = InferenceEngine::from_file(&model_path, Some(config))
      .map_err(|e| format!("Failed to load layout model {}: {e}", model_path.display()))?;

    // Input size: prefer the meta declaration; otherwise read it from the
    // model's own input tensor (NCHW [1, C, H, W] → the last two dims), so
    // bundled models don't need a hardcoded size.
    let input_size = resolve_input_size(&meta, &engine)?;

    Ok(Self {
      engine: Some(engine),
      meta,
      score_threshold,
      input_size,
      v3: None,
    })
  }

  /// Whether the active model already emits regions in its predicted reading
  /// order (DETR models do). When true, callers should NOT apply the geometric
  /// XY-Cut re-sort, so skewed / curved documents keep the model's order.
  pub fn reading_order(&self) -> bool {
    self.v3.is_some()
  }

  /// Detect layout regions on a page image.
  ///
  /// DETR models are routed to the standalone `[N, 7]` decode; the PicoDet
  /// path expects one tensor whose last dimension is 6:
  /// `[class_id, score, x1, y1, x2, y2]` in the model input (letterboxed)
  /// coordinate space. Coordinates are mapped back to the original image. This
  /// decode must be validated against the converted models (design acceptance:
  /// bbox IoU > 0.95 vs PaddleX).
  pub fn detect(&self, image: &DynamicImage) -> Result<Vec<LayoutRegion>, String> {
    if let Some(v3) = &self.v3 {
      return v3.detect(image, &self.meta, self.score_threshold);
    }
    let engine = self
      .engine
      .as_ref()
      .ok_or_else(|| "layout engine not initialized".to_string())?;
    let (orig_w, orig_h) = (image.width() as f64, image.height() as f64);
    let (in_w, in_h) = (self.input_size.0 as f64, self.input_size.1 as f64);

    let input = preprocess_layout_image(image, &self.meta, in_w, in_h)?;
    let output = engine
      .run_dynamic(input.view().into_dyn())
      .map_err(|e| format!("Layout inference failed: {e}"))?;

    let shape = output.shape();
    let row_len = *shape.last().unwrap_or(&0);
    if row_len != 6 {
      return Err(format!(
        "Unexpected layout model output shape {:?} (expected rows of 6)",
        shape
      ));
    }
    let rows = shape[..shape.len() - 1].iter().product::<usize>();
    let data = output
      .as_slice()
      .ok_or_else(|| "layout output tensor is not contiguous".to_string())?;

    let mut regions = Vec::new();
    for r in 0..rows {
      let base = r * 6;
      let class_id = data[base] as usize;
      let score = data[base + 1];
      if !(score >= self.score_threshold) {
        continue;
      }
      // Model coordinates live in the resized input space; map them back to
      // the original image (stretch or letterbox depending on keep_ratio).
      let (x1, y1) = map_model_point(
        data[base + 2] as f64,
        data[base + 3] as f64,
        orig_w,
        orig_h,
        in_w,
        in_h,
        self.meta.keep_ratio,
      );
      let (x2, y2) = map_model_point(
        data[base + 4] as f64,
        data[base + 5] as f64,
        orig_w,
        orig_h,
        in_w,
        in_h,
        self.meta.keep_ratio,
      );
      if x2 <= x1 || y2 <= y1 {
        continue;
      }
      regions.push(LayoutRegion {
        class: self.meta.class_bucket(class_id),
        rect: LayoutRect {
          x: x1,
          y: y1,
          width: x2 - x1,
          height: y2 - y1,
        },
        score: score as f64,
      });
    }
    Ok(nms(regions))
  }
}

/// Resolve the model input size (width, height). The meta declaration wins;
/// when it is unset (0), read the last two dims of the model's input tensor
/// (`[1, C, H, W]` NCHW). Dynamic-shape models report huge sentinel values,
/// which are rejected so the caller degrades to `rule` instead of letterboxing
/// into a garbage size.
fn resolve_input_size(
  meta: &LayoutModelMeta,
  engine: &InferenceEngine,
) -> Result<(u32, u32), String> {
  if meta.input_width > 0 && meta.input_height > 0 {
    return Ok((meta.input_width, meta.input_height));
  }
  const SENTINEL: usize = 100_000;
  let shape = engine.input_shape();
  if shape.len() >= 2 {
    let h = shape[shape.len() - 2];
    let w = shape[shape.len() - 1];
    if h > 0 && h < SENTINEL && w > 0 && w < SENTINEL {
      return Ok((w as u32, h as u32));
    }
  }
  Err(format!(
    "layout model input size is unknown (shape {:?}); declare inputWidth/inputHeight in layout-meta.json",
    shape
  ))
}

// ─── Reading order (XY-Cut) ──────────────────────────────────────────────

/// Find the widest empty band along `vertical` (x) or horizontal (y) that
/// splits `regions` into two non-empty groups. Returns the cut coordinate.
fn find_cut(regions: &[LayoutRegion], vertical: bool, min_gap: f64) -> Option<f64> {
  if regions.len() < 2 {
    return None;
  }
  let interval = |r: &LayoutRegion| {
    if vertical {
      (r.rect.x, r.rect.right())
    } else {
      (r.rect.y, r.rect.bottom())
    }
  };
  let mut edges: Vec<(f64, i32)> = Vec::with_capacity(regions.len() * 2);
  for r in regions {
    let (a, b) = interval(r);
    edges.push((a, 1));
    edges.push((b, -1));
  }
  edges.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

  let mut coverage = 0i32;
  let mut prev = edges[0].0;
  let mut best: Option<(f64, f64)> = None;
  for (x, delta) in edges {
    if coverage == 0 && x > prev {
      let gap = x - prev;
      let mid = (prev + x) / 2.0;
      let (lo, hi): (Vec<_>, Vec<_>) = regions.iter().partition(|r| {
        let center = if vertical {
          r.rect.center().0
        } else {
          r.rect.center().1
        };
        center <= mid
      });
      if gap >= min_gap && !lo.is_empty() && !hi.is_empty() {
        if best.map_or(true, |(best_w, _)| gap > best_w) {
          best = Some((gap, mid));
        }
      }
    }
    coverage += delta;
    prev = x;
  }
  best.map(|(_, cut)| cut)
}

/// Sort layout regions into reading order with a recursive XY-Cut: try a
/// vertical (column) cut first, then a horizontal one, falling back to a
/// plain top→left sort inside each leaf.
pub fn sort_reading_order(regions: &mut Vec<LayoutRegion>, page_w: f64, page_h: f64) {
  if regions.len() <= 1 {
    return;
  }
  let min_vgap = (page_w * MIN_GAP_RATIO).max(MIN_GAP_PX);
  if let Some(cut) = find_cut(regions, true, min_vgap) {
    let all = std::mem::take(regions);
    let (mut left, mut right): (Vec<_>, Vec<_>) =
      all.into_iter().partition(|r| r.rect.center().0 <= cut);
    sort_reading_order(&mut left, page_w, page_h);
    sort_reading_order(&mut right, page_w, page_h);
    regions.extend(left);
    regions.extend(right);
    return;
  }
  let min_hgap = (page_h * MIN_GAP_RATIO).max(MIN_GAP_PX);
  if let Some(cut) = find_cut(regions, false, min_hgap) {
    let all = std::mem::take(regions);
    let (mut top, mut bottom): (Vec<_>, Vec<_>) =
      all.into_iter().partition(|r| r.rect.center().1 <= cut);
    sort_reading_order(&mut top, page_w, page_h);
    sort_reading_order(&mut bottom, page_w, page_h);
    regions.extend(top);
    regions.extend(bottom);
    return;
  }
  regions.sort_by(|a, b| {
    a.rect
      .y
      .partial_cmp(&b.rect.y)
      .unwrap_or(std::cmp::Ordering::Equal)
      .then_with(|| {
        a.rect
          .x
          .partial_cmp(&b.rect.x)
          .unwrap_or(std::cmp::Ordering::Equal)
      })
  });
}

// ─── Markdown assembly ───────────────────────────────────────────────────

/// Group OCR blocks into visual lines, byte-compatible with the non-layout
/// path (`LocalOcrEngine::recognize_image_with_confidence`): Y-sorted,
/// consecutive gap > `max(1.5% page height, 8px)` starts a new line, each line
/// X-sorted and joined with `separator`.
pub fn blocks_to_lines(blocks: &[&OcrBlock], image_h: f64, separator: &str) -> Vec<String> {
  let threshold = (image_h * 0.015).max(8.0);
  let mut items: Vec<&OcrBlock> = blocks.to_vec();
  items.sort_by(|a, b| {
    a.top
      .partial_cmp(&b.top)
      .unwrap_or(std::cmp::Ordering::Equal)
  });
  let mut lines: Vec<Vec<&OcrBlock>> = Vec::new();
  let mut current: Vec<&OcrBlock> = Vec::new();
  let mut current_y = items.first().map(|b| b.top).unwrap_or(0.0);
  for b in &items {
    if !current.is_empty() && (b.top - current_y).abs() > threshold {
      current.sort_by(|a, b| {
        a.left
          .partial_cmp(&b.left)
          .unwrap_or(std::cmp::Ordering::Equal)
      });
      lines.push(current);
      current = Vec::new();
    }
    current_y = b.top;
    current.push(b);
  }
  if !current.is_empty() {
    current.sort_by(|a, b| {
      a.left
        .partial_cmp(&b.left)
        .unwrap_or(std::cmp::Ordering::Equal)
    });
    lines.push(current);
  }
  lines
    .iter()
    .map(|line| {
      line
        .iter()
        .map(|b| b.text.as_str())
        .collect::<Vec<_>>()
        .join(separator)
    })
    .collect()
}

/// Vertical gap (px) below which two blocks belong to the same visual line.
fn line_gap(page_h: f64) -> f64 {
  (page_h * 0.015).max(8.0)
}

/// Horizontal gap (px) above which two adjacent blocks in a line are treated
/// as separate columns / table cells.
fn column_gap(page_w: f64) -> f64 {
  (page_w * COLUMN_GAP_RATIO).max(COLUMN_GAP_MIN_PX)
}

/// Cluster OCR blocks into a grid of cells (`rows × columns`), where each cell
/// is the space-joined text of the blocks that fall on the same visual line and
/// in the same column. Cells are split by horizontal gaps (`column_gap`).
fn build_grid(blocks: &[&OcrBlock], page_w: f64, page_h: f64) -> Vec<Vec<String>> {
  let threshold_y = line_gap(page_h);
  let gap_x = column_gap(page_w);

  let mut items: Vec<&OcrBlock> = blocks.to_vec();
  items.sort_by(|a, b| {
    a.top
      .partial_cmp(&b.top)
      .unwrap_or(std::cmp::Ordering::Equal)
  });

  // 1) Group into visual rows by vertical proximity.
  let mut rows: Vec<Vec<&OcrBlock>> = Vec::new();
  let mut current_y = items.first().map(|b| b.top).unwrap_or(0.0);
  for b in &items {
    if let Some(last) = rows.last_mut() {
      if (b.top - current_y).abs() > threshold_y {
        rows.push(vec![*b]);
        current_y = b.top;
        continue;
      }
      last.push(*b);
    } else {
      rows.push(vec![*b]);
    }
    current_y = b.top;
  }

  // 2) Split each row into columns by horizontal gap.
  rows
    .into_iter()
    .map(|mut row| {
      row.sort_by(|a, b| {
        a.left
          .partial_cmp(&b.left)
          .unwrap_or(std::cmp::Ordering::Equal)
      });
      let mut cells: Vec<Vec<String>> = Vec::new();
      let mut prev_right = row.first().map(|b| b.left + b.width).unwrap_or(0.0);
      for b in row {
        if b.left - prev_right > gap_x {
          cells.push(vec![b.text.clone()]);
        } else {
          match cells.last_mut() {
            Some(cell) => cell.push(b.text.clone()),
            None => cells.push(vec![b.text.clone()]),
          }
        }
        prev_right = b.left + b.width;
      }
      cells.into_iter().map(|cell| cell.join(" ")).collect()
    })
    .collect()
}

/// Whether a block grid is regular enough to be rendered as a table (≥2 rows
/// with ≥2 columns each). This keeps plain single-column prose as text.
fn is_table_like(grid: &[Vec<String>]) -> bool {
  grid.len() >= TABLE_MIN_ROWS
    && grid
      .iter()
      .filter(|row| row.len() >= TABLE_MIN_COLUMNS)
      .count()
      >= 2
}

/// Escape `|` inside a cell so it doesn't break the Markdown table.
fn escape_cell(s: &str) -> String {
  s.replace('|', "\\|")
}

/// Render a `rows × cols` grid as a Markdown table. Per the GFM spec a table
/// needs a header row followed by a `|---|` separator row, otherwise `| a | b |`
/// lines render as plain text. The first data row is therefore emitted as the
/// header and a separator row is inserted after it.
fn grid_to_markdown(grid: &[Vec<String>]) -> String {
  let cols = grid.iter().map(|r| r.len()).max().unwrap_or(0);
  if cols == 0 {
    return String::new();
  }
  let render = |cells: &[String]| {
    let mut padded: Vec<String> = cells.to_vec();
    padded.resize(cols, String::new());
    format!(
      "| {} |",
      padded
        .iter()
        .map(|c| escape_cell(c))
        .collect::<Vec<_>>()
        .join(" | ")
    )
  };
  let mut rows: Vec<String> = Vec::new();
  for (i, row) in grid.iter().enumerate() {
    rows.push(render(row));
    if i == 0 {
      rows.push(render(&vec!["---".to_string(); cols]));
    }
  }
  rows.join("\n")
}

/// Markdown heading level for a title region: `#` for a document title
/// (tall region), `##` / `###` for paragraph titles bucketed by region height.
fn title_level(region: &LayoutRegion, page_h: f64) -> usize {
  if region.rect.height >= page_h * 0.05 {
    1
  } else if region.rect.height >= page_h * 0.025 {
    2
  } else {
    3
  }
}

/// Render one region's markdown chunk from the OCR blocks assigned to it.
fn region_chunk(
  region: &LayoutRegion,
  blocks: &[&OcrBlock],
  page_w: f64,
  page_h: f64,
  separator: &str,
  drop_header_footer: bool,
) -> String {
  match region.class {
    LayoutClass::Header | LayoutClass::Footer => {
      let label = if region.class == LayoutClass::Header {
        "页眉"
      } else {
        "页脚"
      };
      if drop_header_footer {
        // Keep an auditable trace as an HTML comment (design risk table).
        let summary = blocks_to_lines(blocks, page_h, separator).join(" ");
        if summary.trim().is_empty() {
          String::new()
        } else {
          format!("<!-- 已过滤{label}: {summary} -->")
        }
      } else {
        blocks_to_lines(blocks, page_h, separator).join("\n")
      }
    }
    LayoutClass::Seal => String::new(),
    LayoutClass::Figure => "![figure](figure_placeholder)".to_string(),
    LayoutClass::Table => {
      let grid = build_grid(blocks, page_w, page_h);
      if grid.is_empty() {
        String::new()
      } else {
        grid_to_markdown(&grid)
      }
    }
    LayoutClass::Title => {
      let lines = blocks_to_lines(blocks, page_h, separator);
      if lines.is_empty() {
        return String::new();
      }
      let level = title_level(region, page_h);
      format!("{} {}", "#".repeat(level), lines.join(" "))
    }
    LayoutClass::Text | LayoutClass::Other => {
      // Render regular multi-column content as a table too (design: "类似表格
      // 的规整列也输出表格"), while keeping single-column prose as plain text.
      let grid = build_grid(blocks, page_w, page_h);
      if is_table_like(&grid) {
        grid_to_markdown(&grid)
      } else {
        blocks_to_lines(blocks, page_h, separator).join("\n")
      }
    }
  }
}

/// Assemble the page Markdown from layout regions + OCR blocks.
///
/// Every block is assigned to the smallest region containing its center (the
/// same center-based 归属 used by the table extractors, avoiding cross-region
/// duplication). Region chunks are joined with a blank line; blocks that no
/// region covers are backfilled at the end in geometry order so detection
/// misses never lose text (design §3.4). A single region therefore produces
/// exactly the same lines as the non-layout path.
pub fn assemble_markdown(
  regions: &[LayoutRegion],
  blocks: &[OcrBlock],
  page_w: f64,
  page_h: f64,
  separator: &str,
  drop_header_footer: bool,
) -> String {
  let mut region_blocks: Vec<Vec<&OcrBlock>> = vec![Vec::new(); regions.len()];
  let mut unassigned: Vec<&OcrBlock> = Vec::new();
  for b in blocks {
    let (cx, cy) = (b.left + b.width * 0.5, b.top + b.height * 0.5);
    let mut best: Option<usize> = None;
    let mut best_area = f64::INFINITY;
    for (i, r) in regions.iter().enumerate() {
      if r.rect.contains(cx, cy) && r.rect.area() < best_area {
        best_area = r.rect.area();
        best = Some(i);
      }
    }
    match best {
      Some(i) => region_blocks[i].push(b),
      None => unassigned.push(b),
    }
  }

  let mut chunks: Vec<String> = Vec::new();
  for (i, region) in regions.iter().enumerate() {
    let chunk = region_chunk(
      region,
      &region_blocks[i],
      page_w,
      page_h,
      separator,
      drop_header_footer,
    );
    if !chunk.trim().is_empty() {
      chunks.push(chunk);
    }
  }
  if !unassigned.is_empty() {
    let mut sorted = unassigned;
    sorted.sort_by(|a, b| {
      a.top
        .partial_cmp(&b.top)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| {
          a.left
            .partial_cmp(&b.left)
            .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    let lines = blocks_to_lines(&sorted, page_h, separator);
    if !lines.is_empty() {
      chunks.push(lines.join("\n"));
    }
  }
  chunks.join("\n\n")
}

#[cfg(test)]
mod tests {
  use super::*;

  fn block(text: &str, left: f64, top: f64, width: f64, height: f64) -> OcrBlock {
    OcrBlock {
      text: text.to_string(),
      left,
      top,
      width,
      height,
    }
  }

  fn rect(x: f64, y: f64, w: f64, h: f64) -> LayoutRect {
    LayoutRect {
      x,
      y,
      width: w,
      height: h,
    }
  }

  fn region(class: LayoutClass, r: LayoutRect) -> LayoutRegion {
    LayoutRegion {
      class,
      rect: r,
      score: 1.0,
    }
  }

  #[test]
  fn detr_rows_decode_thresholds_and_orders_by_reading_order() {
    // 800x800 input space, stretched from a 1200x1600 page.
    let meta: LayoutModelMeta = serde_json::from_str(
      r#"{
        "name": "PP-DocLayoutV3",
        "inputWidth": 800,
        "inputHeight": 800,
        "keepRatio": false,
        "mean": [0,0,0],
        "std": [1,1,1],
        "scoreThreshold": 0.5,
        "engine": "detr",
        "classes": ["text", "seal", "table", "doc_title", "image"],
        "bucketMap": { "seal": "Seal", "doc_title": "Title" }
      }"#,
    )
    .unwrap();
    // rows: [class, score, x1, y1, x2, y2, reading_order]
    let data = vec![
      3.0, 0.9, 400.0, 400.0, 800.0, 800.0, 2.0, // doc_title -> Title, order 2
      1.0, 0.8, 0.0, 0.0, 400.0, 400.0, 0.0, // seal, order 0
      4.0, 0.6, 100.0, 100.0, 600.0, 600.0, 1.0, // image, order 1
      2.0, 0.1, 0.0, 0.0, 100.0, 100.0, 9.0, // below threshold -> dropped
      9.0, 0.7, 10.0, 8.0, 20.0, 10.0, 3.0, // unknown class id -> Other
    ];
    let regions = decode_detr_rows(&data, 5, &meta, 0.5, 1200.0, 1600.0, 800.0, 800.0).unwrap();
    // The sub-threshold row is dropped and the valid ones are ordered by column 6.
    assert_eq!(regions.len(), 4);
    assert_eq!(regions[0].class, LayoutClass::Seal); // order 0
    assert_eq!(regions[1].class, LayoutClass::Figure); // order 1 (image -> Figure)
    assert_eq!(regions[2].class, LayoutClass::Title); // order 2
    assert_eq!(regions[3].class, LayoutClass::Other); // order 3 (out-of-range class id)
  }

  #[test]
  fn detr_rows_map_back_from_stretch_input_space() {
    // 1200x1600 original stretched to 800x800: x scale 800/1200=2/3, y 800/1600=1/2.
    // Detected (x1,y1,x2,y2)=(120, 100, 600, 500) -> (180, 200, 900, 1000).
    let meta: LayoutModelMeta = serde_json::from_str(
      r#"{"name":"v3","inputWidth":800,"inputHeight":800,"keepRatio":false,"mean":[0,0,0],"std":[1,1,1],"engine":"detr","classes":["text"]}"#,
    )
    .unwrap();
    let data = vec![0.0, 0.9, 120.0, 100.0, 600.0, 500.0, 0.0];
    let regions = decode_detr_rows(&data, 1, &meta, 0.5, 1200.0, 1600.0, 800.0, 800.0).unwrap();
    assert_eq!(regions.len(), 1);
    assert!((regions[0].rect.x - 180.0).abs() < 1.0);
    assert!((regions[0].rect.y - 200.0).abs() < 1.0);
    assert!((regions[0].rect.width - 720.0).abs() < 1.0);
    assert!((regions[0].rect.height - 800.0).abs() < 1.0);
  }

  #[test]
  fn layout_class_parse_maps_buckets() {
    assert_eq!(LayoutClass::parse("doc_title"), LayoutClass::Title);
    assert_eq!(LayoutClass::parse("paragraph_title"), LayoutClass::Title);
    assert_eq!(LayoutClass::parse("text"), LayoutClass::Text);
    assert_eq!(LayoutClass::parse("table"), LayoutClass::Table);
    assert_eq!(LayoutClass::parse("figure"), LayoutClass::Figure);
    assert_eq!(LayoutClass::parse("page_header"), LayoutClass::Header);
    assert_eq!(LayoutClass::parse("page_footer"), LayoutClass::Footer);
    assert_eq!(LayoutClass::parse("seal"), LayoutClass::Seal);
    // Unknown classes fall into Other (treated as body text).
    assert_eq!(LayoutClass::parse("something_new"), LayoutClass::Other);
  }

  #[test]
  fn layout_model_meta_parses_and_buckets() {
    let meta: LayoutModelMeta = serde_json::from_str(
      r#"{
        "name": "PP-DocLayout-S",
        "displayName": "PP-DocLayout-S",
        "inputWidth": 800,
        "inputHeight": 1330,
        "mean": [0.485, 0.456, 0.406],
        "std": [0.229, 0.224, 0.225],
        "scoreThreshold": 0.5,
        "classes": ["text", "paragraph_title", "seal", "unknown_new"],
        "bucketMap": { "paragraph_title": "Title", "seal": "Seal" }
      }"#,
    )
    .unwrap();
    // Mapped class → its bucket; unmapped known class → parsed by name.
    assert_eq!(meta.class_bucket(1), LayoutClass::Title);
    assert_eq!(meta.class_bucket(2), LayoutClass::Seal);
    assert_eq!(meta.class_bucket(0), LayoutClass::Text);
    // Class absent from the table → Other.
    assert_eq!(meta.class_bucket(99), LayoutClass::Other);
    // Capabilities derived from the whole class table, canonical order.
    assert_eq!(meta.bucket_capabilities(), vec!["title", "text", "seal"]);
  }

  #[test]
  fn layout_model_meta_uses_defaults_for_partial_meta() {
    let meta: LayoutModelMeta = serde_json::from_str(r#"{"name":"x"}"#).unwrap();
    // Unset input size means "read from the model at load time".
    assert_eq!(meta.input_width, 0);
    assert_eq!(meta.input_height, 0);
    // Unset model file defaults to the conventional `model.mnn`.
    assert_eq!(meta.model_file, "model.mnn");
    // PaddleX PicoDet models resize by stretching (keep_ratio = false).
    assert!(!meta.keep_ratio);
    assert_eq!(meta.score_threshold, 0.5);
    assert_eq!(meta.mean, [0.485, 0.456, 0.406]);
  }

  #[test]
  fn layout_model_meta_accepts_declared_model_file_and_input_size() {
    let meta: LayoutModelMeta = serde_json::from_str(
      r#"{"name":"x","modelFile":"PicoDet-S-layout-17cls.mnn","inputWidth":480,"inputHeight":480,"keepRatio":false}"#,
    )
    .unwrap();
    assert_eq!(meta.model_file, "PicoDet-S-layout-17cls.mnn");
    assert_eq!((meta.input_width, meta.input_height), (480, 480));
    assert!(!meta.keep_ratio);
  }

  #[test]
  fn map_model_point_stretch_scales_per_axis() {
    // 1200×1600 original → stretched to 480×480 input.
    let (ox, oy) = map_model_point(240.0, 240.0, 1200.0, 1600.0, 480.0, 480.0, false);
    assert_eq!((ox, oy), (600.0, 800.0));
  }

  #[test]
  fn map_model_point_letterbox_undoes_padding() {
    // 1200×800 original → letterboxed into 800×1330: scale = 800/1200 = 2/3,
    // new_h = 533.33, pad_y = (1330 - 533.33)/2 = 398.33. A point at the
    // bottom of the letterboxed content, (400, 931.67), maps back to (600, 800).
    let (ox, oy) = map_model_point(400.0, 931.67, 1200.0, 800.0, 800.0, 1330.0, true);
    assert!((ox - 600.0).abs() < 1.0);
    assert!((oy - 800.0).abs() < 1.0);
  }

  #[test]
  fn blocks_to_lines_matches_off_path_grouping() {
    // Same consecutive-gap grouping as recognize_image_with_confidence.
    let blocks = vec![
      block("b", 10.0, 0.0, 30.0, 10.0),
      block("a", 0.0, 0.0, 10.0, 10.0),       // same line → x-sorted
      block("second", 0.0, 20.0, 40.0, 10.0), // gap > 8px → new line
    ];
    let refs: Vec<&OcrBlock> = blocks.iter().collect();
    let lines = blocks_to_lines(&refs, 100.0, "|");
    assert_eq!(lines, vec!["a|b", "second"]);
  }

  #[test]
  fn xy_cut_orders_columns_left_to_right() {
    let mut regions = vec![
      region(LayoutClass::Text, rect(380.0, 100.0, 200.0, 400.0)),
      region(LayoutClass::Text, rect(40.0, 100.0, 200.0, 400.0)),
    ];
    sort_reading_order(&mut regions, 620.0, 800.0);
    assert_eq!(regions[0].rect.x, 40.0);
    assert_eq!(regions[1].rect.x, 380.0);
  }

  #[test]
  fn xy_cut_orders_rows_top_to_bottom_when_no_columns() {
    let mut regions = vec![
      region(LayoutClass::Text, rect(40.0, 400.0, 500.0, 100.0)),
      region(LayoutClass::Text, rect(40.0, 100.0, 500.0, 100.0)),
    ];
    sort_reading_order(&mut regions, 620.0, 800.0);
    assert_eq!(regions[0].rect.y, 100.0);
    assert_eq!(regions[1].rect.y, 400.0);
  }

  #[test]
  fn assemble_two_columns_produces_left_then_right() {
    let regions = vec![
      region(LayoutClass::Text, rect(40.0, 200.0, 200.0, 300.0)),
      region(LayoutClass::Text, rect(380.0, 200.0, 200.0, 300.0)),
    ];
    let blocks = vec![
      block("right one", 390.0, 210.0, 100.0, 12.0),
      block("left one", 50.0, 210.0, 100.0, 12.0),
      block("left two", 50.0, 260.0, 100.0, 12.0),
    ];
    let md = assemble_markdown(&regions, &blocks, 620.0, 800.0, "|", true);
    assert_eq!(md, "left one\nleft two\n\nright one");
  }

  #[test]
  fn assemble_single_region_matches_plain_lines() {
    let regions = vec![region(LayoutClass::Text, rect(40.0, 200.0, 500.0, 300.0))];
    let blocks = vec![
      block("b", 60.0, 210.0, 100.0, 12.0),
      block("a", 40.0, 210.0, 100.0, 12.0),
      block("c", 40.0, 260.0, 100.0, 12.0),
    ];
    let md = assemble_markdown(&regions, &blocks, 620.0, 800.0, "|", true);
    assert_eq!(md, "a|b\nc");
  }

  #[test]
  fn assemble_renders_heading_and_drops_header_footer() {
    let regions = vec![
      region(LayoutClass::Header, rect(0.0, 0.0, 620.0, 50.0)),
      region(LayoutClass::Title, rect(40.0, 200.0, 200.0, 24.0)),
      region(LayoutClass::Text, rect(40.0, 240.0, 500.0, 100.0)),
      region(LayoutClass::Footer, rect(0.0, 750.0, 620.0, 50.0)),
    ];
    let blocks = vec![
      block("header text", 200.0, 10.0, 200.0, 12.0),
      block("Doc title", 50.0, 205.0, 150.0, 20.0),
      block("Body", 50.0, 250.0, 300.0, 12.0),
      block("footer text", 200.0, 770.0, 200.0, 12.0),
    ];
    let md = assemble_markdown(&regions, &blocks, 620.0, 800.0, "|", true);
    assert_eq!(
      md,
      "<!-- 已过滤页眉: header text -->\n\n## Doc title\n\nBody\n\n<!-- 已过滤页脚: footer text -->"
    );
  }

  #[test]
  fn assemble_keeps_header_footer_when_not_dropped() {
    let regions = vec![
      region(LayoutClass::Header, rect(0.0, 0.0, 620.0, 50.0)),
      region(LayoutClass::Text, rect(40.0, 200.0, 500.0, 100.0)),
    ];
    let blocks = vec![
      block("header text", 200.0, 10.0, 200.0, 12.0),
      block("Body", 50.0, 250.0, 300.0, 12.0),
    ];
    let md = assemble_markdown(&regions, &blocks, 620.0, 800.0, "|", false);
    assert_eq!(md, "header text\n\nBody");
  }

  #[test]
  fn assemble_backfills_unassigned_blocks() {
    // A block outside every region must still appear (never lose text).
    let regions = vec![region(LayoutClass::Text, rect(40.0, 200.0, 500.0, 100.0))];
    let blocks = vec![
      block("covered", 50.0, 210.0, 100.0, 12.0),
      block("missed", 50.0, 500.0, 100.0, 12.0),
    ];
    let md = assemble_markdown(&regions, &blocks, 620.0, 800.0, "|", true);
    assert_eq!(md, "covered\n\nmissed");
  }

  #[test]
  fn assemble_renders_regular_columns_as_table_even_when_text_class() {
    // Regular 2-column rows classified as Text still become a Markdown table.
    let regions = vec![region(LayoutClass::Text, rect(40.0, 100.0, 540.0, 300.0))];
    let blocks = vec![
      block("h1", 50.0, 110.0, 100.0, 12.0),
      block("h2", 400.0, 110.0, 100.0, 12.0),
      block("r1c1", 50.0, 160.0, 100.0, 12.0),
      block("r1c2", 400.0, 160.0, 100.0, 12.0),
    ];
    let md = assemble_markdown(&regions, &blocks, 620.0, 800.0, "|", true);
    assert_eq!(md, "| h1 | h2 |\n| --- | --- |\n| r1c1 | r1c2 |");
  }

  #[test]
  fn assemble_table_region_emits_markdown_table() {
    let regions = vec![region(LayoutClass::Table, rect(40.0, 100.0, 540.0, 300.0))];
    let blocks = vec![
      block("a", 50.0, 110.0, 100.0, 12.0),
      block("b", 400.0, 110.0, 100.0, 12.0),
      block("c", 50.0, 160.0, 100.0, 12.0),
      block("d", 400.0, 160.0, 100.0, 12.0),
    ];
    let md = assemble_markdown(&regions, &blocks, 620.0, 800.0, "|", true);
    assert_eq!(md, "| a | b |\n| --- | --- |\n| c | d |");
  }

  #[test]
  fn assemble_keeps_single_column_prose_as_text() {
    // Two full-width blocks on separate lines stay plain text, not a table.
    let regions = vec![region(LayoutClass::Text, rect(40.0, 200.0, 500.0, 200.0))];
    let blocks = vec![
      block("a long prose line", 50.0, 210.0, 400.0, 12.0),
      block("another prose line", 50.0, 260.0, 400.0, 12.0),
    ];
    let md = assemble_markdown(&regions, &blocks, 620.0, 800.0, "|", true);
    assert_eq!(md, "a long prose line\nanother prose line");
  }
}
