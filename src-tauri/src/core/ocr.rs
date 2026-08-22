use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use ocr_rs::OcrEngine;
use reqwest::Client;
use tauri::AppHandle;
use uuid::Uuid;

use crate::core::page_marker::page_marker;
use crate::core::settings;
use crate::core::{extract_cache, get_resources_dir};
use crate::models::{
  ConvertResult, DetectResult, HybridSessionInfo, LayoutDto, OcrImageResult, OcrMode, OcrVendor,
  PdfTypeDto,
};

/// Prompt sent to the vision model for every OCR page.
const OCR_PROMPT: &str = "你是一个专业的OCR引擎.请完整识别这张PDF页面图片中的内容,并转换为规范的Markdown输出: 保留标题层级(#、##)、段落、列表、表格(使用GFM表格语法)等结构.只输出识别后的Markdown内容,不要使用任何代码块或代码围栏包裹,不要添加任何解释或前言.";

/// Local OCR engine wrapper for PaddleOCR via ocr-rs.
pub struct LocalOcrEngine {
  engine: OcrEngine,
}

impl LocalOcrEngine {
  /// Create a new local OCR engine with the provided model paths.
  pub fn new(det_model: &str, rec_model: &str, keys_file: &str) -> Result<Self, String> {
    let engine = OcrEngine::new(det_model, rec_model, keys_file, None)
      .map_err(|e| format!("Failed to initialize local OCR engine: {e}"))?;
    Ok(Self { engine })
  }

  /// Recognize text in an image from PNG bytes and return the text.
  /// Sorts text blocks by reading order: top-to-bottom, then left-to-right
  /// within each line, and joins same-line blocks with spaces.
  pub fn recognize_from_png(&self, png_data: &[u8], separator: &str) -> Result<String, String> {
    self.recognize_bytes(png_data, separator)
  }

  /// Recognize text in an image from encoded bytes (PNG or JPEG) and return
  /// the text. Block ordering matches [`Self::recognize_from_png`].
  pub fn recognize_bytes(&self, image_data: &[u8], separator: &str) -> Result<String, String> {
    let image =
      image::load_from_memory(image_data).map_err(|e| format!("Failed to load image: {e}"))?;

    let results = self
      .engine
      .recognize(&image)
      .map_err(|e| format!("Local OCR recognition failed: {e}"))?;

    if results.is_empty() {
      return Ok(String::new());
    }

    // Adaptive threshold: ~1.5% of image height, or at least 8px.
    let line_threshold = (image.height() as f64 * 0.015).max(8.0);

    // Build sortable items with position info.
    let mut items: Vec<(f64, f64, &str)> = results
      .iter()
      .map(|r| {
        let y = r.bbox.rect.top() as f64;
        let x = r.bbox.rect.left() as f64;
        (y, x, r.text.as_str())
      })
      .collect();

    // Sort by Y (top-to-bottom).
    items.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    // Group into lines: items whose Y difference is within threshold.
    let mut lines: Vec<Vec<(f64, &str)>> = Vec::new();
    let mut current_line: Vec<(f64, &str)> = Vec::new();
    let mut current_y: f64 = items[0].0;

    for (y, x, text) in &items {
      if (y - current_y).abs() > line_threshold && !current_line.is_empty() {
        // Sort current line by X (left-to-right) before pushing.
        current_line.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        lines.push(current_line);
        current_line = Vec::new();
      }
      current_y = *y;
      current_line.push((*x, text));
    }
    if !current_line.is_empty() {
      current_line.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
      lines.push(current_line);
    }

    // Join each line's blocks with the configured separator, separate lines with newlines.
    let output = lines
      .iter()
      .map(|line| {
        line
          .iter()
          .map(|(_, text)| *text)
          .collect::<Vec<_>>()
          .join(separator)
      })
      .collect::<Vec<_>>()
      .join("\n");

    Ok(output)
  }
}

/// One recognized text block with its bounding box in image pixel space
/// (origin at the top-left corner of the image).
#[derive(Debug, Clone)]
pub struct OcrBlock {
  pub text: String,
  pub left: f64,
  pub top: f64,
  pub width: f64,
  pub height: f64,
}

/// Recognition output for one image: positioned text blocks plus the source
/// image dimensions, so callers can map pixel coordinates into another space.
#[derive(Debug, Clone)]
pub struct OcrRecognition {
  pub blocks: Vec<OcrBlock>,
  pub height_px: u32,
}

impl LocalOcrEngine {
  /// Recognize text blocks **with positions** from PNG bytes. Unlike
  /// [`recognize_from_png`] this keeps every block's bounding box instead of
  /// merging blocks into lines, which lets the draw-table extraction cut
  /// recognized text by user-drawn column boundaries.
  pub fn recognize_png_blocks(&self, png_data: &[u8]) -> Result<OcrRecognition, String> {
    let image =
      image::load_from_memory(png_data).map_err(|e| format!("Failed to load image: {e}"))?;

    let results = self
      .engine
      .recognize(&image)
      .map_err(|e| format!("Local OCR recognition failed: {e}"))?;

    let blocks = results
      .iter()
      .filter(|r| !r.text.trim().is_empty())
      .map(|r| OcrBlock {
        text: r.text.clone(),
        left: r.bbox.rect.left().max(0) as f64,
        top: r.bbox.rect.top().max(0) as f64,
        width: r.bbox.rect.width() as f64,
        height: r.bbox.rect.height() as f64,
      })
      .collect();

    Ok(OcrRecognition {
      blocks,
      height_px: image.height(),
    })
  }
}

/// Helper to build the resource directory path for OCR models.
fn ocr_resource_dir(_app: &AppHandle) -> Result<PathBuf, String> {
  let base = get_resources_dir().join("ppocr");
  if base.exists() {
    return Ok(base);
  }
  Err(format!(
    "OCR model directory not found. Please place models at:\n  {}",
    base.display(),
  ))
}

/// Create a local OCR engine from the bundled models.
pub fn create_local_ocr_engine(app: &AppHandle) -> Result<LocalOcrEngine, String> {
  let dir = ocr_resource_dir(app)?;
  let det = dir.join("PP-OCRv6_medium_det.mnn");
  let rec = dir.join("PP-OCRv6_medium_rec.mnn");
  let keys = dir.join("ppocr_keys_v6_medium.txt");

  LocalOcrEngine::new(
    &det.to_string_lossy(),
    &rec.to_string_lossy(),
    &keys.to_string_lossy(),
  )
}

/// Some vision models wrap their markdown answer in a fenced code block even
/// when asked not to. Strip one outer ``` fence so the OCR result is rendered
/// as markdown instead of being embedded inside a code block.
fn strip_markdown_fence(text: &str) -> String {
  let trimmed = text.trim();
  let lines: Vec<&str> = trimmed.lines().collect();
  let opens_with_fence = lines
    .first()
    .is_some_and(|l| l.trim_start().starts_with("```"));
  let closes_with_fence = lines.last().is_some_and(|l| l.trim().starts_with("```"));
  if opens_with_fence && closes_with_fence && lines.len() > 2 {
    let inner = lines[1..lines.len() - 1].join("\n");
    let inner_trimmed = inner.trim();
    if !inner_trimmed.is_empty() {
      return inner_trimmed.to_string();
    }
  }
  trimmed.to_string()
}

/// Sessions are dropped after this long even if the frontend never closes them.
const SESSION_MAX_AGE: Duration = Duration::from_secs(30 * 60);
/// Hard cap on in-flight sessions to bound memory.
const SESSION_MAX_COUNT: usize = 32;

/// Build the chat-completions endpoint from a vendor base URL.
fn completions_url(base_url: &str) -> String {
  let base = base_url.trim().trim_end_matches('/');
  if base.ends_with("/chat/completions") || base.ends_with("/v1") {
    base.to_string()
  } else {
    format!("{base}/v1/chat/completions")
  }
}

/// Pick the provider used for OCR: prefer a configured vendor that has a
/// stored key, at least one model, and a model explicitly marked as default;
/// otherwise fall back to the first vendor with a stored key and a model.
fn resolve_provider(vendors: &[OcrVendor]) -> Option<(&OcrVendor, &crate::models::OcrModel)> {
  let usable = |v: &&OcrVendor| v.api_key.is_some() && !v.models.is_empty();
  let vendor = vendors
    .iter()
    .find(|v| usable(v) && v.models.iter().any(|m| m.default))
    .or_else(|| vendors.iter().find(usable))?;
  let model = vendor
    .models
    .iter()
    .find(|m| m.default)
    .or_else(|| vendor.models.first())?;
  Some((vendor, model))
}

/// A resolved remote vision provider for the draw-table OCR fallback.
pub struct RemoteOcrProvider {
  pub client: Client,
  pub base_url: String,
  pub model_id: String,
  pub api_key: String,
}

/// Prompt for draw-table AI recognition: the model must cut the table by the
/// user-drawn separator positions and answer with a bare GFM table.
const DRAW_TABLE_PROMPT: &str = "你是一个专业的表格识别引擎.这张PDF页面图片中的表格带有用户标注的列分隔线.请严格按照下方给出的分隔线位置把页面内容切分成列,识别表格的所有行(第一行为表头),输出为规范的GFM(GitHub Flavored Markdown)表格.只输出Markdown表格本身,不要输出任何解释、前言或代码块围栏.";

/// Resolve the remote vision provider used by the draw-table OCR fallback,
/// with the same vendor / default-model preference as hybrid conversion
/// sessions. Returns `None` when no usable vendor is configured.
pub fn resolve_remote_provider(app: &AppHandle) -> Result<Option<RemoteOcrProvider>, String> {
  let vendors = settings::get_ocr_config(app)?;
  let Some((vendor, model)) = resolve_provider(&vendors) else {
    return Ok(None);
  };
  let api_key = settings::api_key_for(app, &vendor.id)?
    .ok_or_else(|| format!("The API Key of supplier '{}' is empty", vendor.name))?;
  let client = Client::builder()
    .timeout(Duration::from_secs(300))
    .connect_timeout(Duration::from_secs(30))
    .build()
    .map_err(|e| format!("HTTP client initialization failed: {e}"))?;
  Ok(Some(RemoteOcrProvider {
    client,
    base_url: vendor.base_url.clone(),
    model_id: model.name.clone(),
    api_key,
  }))
}

/// Render one group of drawn line positions as a prompt fragment listing
/// percentages of the corresponding image dimension.
fn describe_positions(label: &str, pcts: &[f64]) -> String {
  if pcts.is_empty() {
    return String::new();
  }
  let list = pcts
    .iter()
    .map(|p| format!("{p:.1}%"))
    .collect::<Vec<_>>()
    .join(", ");
  format!("\n{label}: {list}")
}

/// Send one rendered page to the remote vision provider and ask it to extract
/// the table cut by the drawn separator lines. Returns bare GFM markdown.
pub async fn ai_recognize_table(
  provider: &RemoteOcrProvider,
  page: u32,
  image_png: &str,
  vertical_pcts: &[f64],
  horizontal_pcts: &[f64],
) -> Result<String, String> {
  let mut prompt = DRAW_TABLE_PROMPT.to_string();
  prompt.push_str(&describe_positions(
    "竖线位置(相对图片宽度的百分比)",
    vertical_pcts,
  ));
  prompt.push_str(&describe_positions(
    "横线位置(相对图片高度的百分比)",
    horizontal_pcts,
  ));
  ocr_page(
    &provider.client,
    &provider.base_url,
    &provider.model_id,
    &provider.api_key,
    page,
    &prompt,
    "image/png",
    image_png,
  )
  .await
}

/// Send one page image to an OpenAI-compatible `/chat/completions` endpoint
/// and return the extracted markdown. `mime` is the image format used in the
/// data URL (e.g. `"image/png"`, `"image/jpeg"`).
async fn ocr_page(
  client: &Client,
  base_url: &str,
  model_id: &str,
  api_key: &str,
  page: u32,
  prompt: &str,
  mime: &str,
  image_base64: &str,
) -> Result<String, String> {
  let url = completions_url(base_url);
  let body = serde_json::json!({
    "model": model_id,
    "temperature": 0,
    "max_tokens": 4096,
    "messages": [{
      "role": "user",
      "content": [
        { "type": "text", "text": prompt },
        {
          "type": "image_url",
          "image_url": { "url": format!("data:{mime};base64,{image_base64}") }
        }
      ]
    }]
  });

  let response = client
    .post(&url)
    .bearer_auth(api_key)
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("OCR request failed (page {page}): {e}"))?;

  let status = response.status();
  if !status.is_success() {
    let body = response.text().await.unwrap_or_default();
    let snippet: String = body.chars().take(300).collect();
    return Err(format!("OCR service return {status}: {snippet}"));
  }

  let json: serde_json::Value = response
    .json()
    .await
    .map_err(|e| format!("OCR response parsing failed: {e}"))?;

  let text = match &json["choices"][0]["message"]["content"] {
    serde_json::Value::String(s) => Some(s.clone()),
    serde_json::Value::Array(parts) => Some(
      parts
        .iter()
        .filter_map(|p| p["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n"),
    ),
    _ => None,
  };

  match text {
    Some(t) if !t.trim().is_empty() => Ok(strip_markdown_fence(&t)),
    _ => Err(format!("OCR service returned no content (page {page})")),
  }
}

/// Send one already-base64-encoded PNG through the resolved remote vision
/// provider with the standard document-OCR prompt (screenshot pipeline).
pub async fn ai_recognize_image(
  provider: &RemoteOcrProvider,
  image_base64: &str,
) -> Result<String, String> {
  ocr_page(
    &provider.client,
    &provider.base_url,
    &provider.model_id,
    &provider.api_key,
    0,
    OCR_PROMPT,
    "image/png",
    image_base64,
  )
  .await
}

/// An in-flight hybrid conversion. Text pages are extracted once at start and
/// kept as plain markdown; OCR pages are streamed in one at a time so only a
/// single page image (not the whole document) is ever in memory.
pub struct HybridSession {
  /// Per-page markdown for the whole document (0-indexed), matching `info.page_count`.
  pub pages: Vec<String>,
  /// Detection metadata, computed once at start.
  pub info: DetectResult,
  /// `(base_url, model_id, api_key)` when at least one page uses remote OCR.
  pub resolved: Option<(String, String, String)>,
  pub client: Client,
  /// OCR results keyed by 1-indexed page number.
  pub ocr_results: HashMap<u32, String>,
  /// Pages that needed OCR but were skipped because no provider is configured.
  pub skipped_pages: Vec<u32>,
  /// Pages whose OCR request failed (degraded to a placeholder comment).
  pub failed_pages: Vec<u32>,
  /// Reason shown in the skip comment for skipped OCR pages.
  pub skip_reason: &'static str,
  pub start: Instant,
  /// The OCR mode chosen by the user for this session.
  pub ocr_mode: OcrMode,
}

/// Managed store of live hybrid sessions keyed by a generated session id.
pub struct HybridStore(pub Mutex<HashMap<String, HybridSession>>);

impl HybridStore {
  /// Lock the session map, recovering from poisoning instead of panicking so a
  /// panicked OCR task can never take down the whole app.
  fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, HybridSession>> {
    self.0.lock().unwrap_or_else(|e| e.into_inner())
  }
}

impl Default for HybridStore {
  fn default() -> Self {
    Self(Mutex::new(HashMap::new()))
  }
}

/// Begin a hybrid conversion session: extract all text pages once, resolve the
/// OCR provider, and stash everything the per-page steps need.
pub fn start_session(
  app: &AppHandle,
  store: &HybridStore,
  path: &str,
  ocr_pages: Vec<u32>,
) -> Result<HybridSessionInfo, String> {
  let start = Instant::now();

  let use_cache = settings::get_app_settings(app)?.cache_extracted_text;
  let ext = extract_cache::cached_extraction(path, use_cache)
    .map_err(|e| format!("Text extraction failed: {e}"))?;
  let page_markdowns = ext.page_markdowns;
  let page_count = page_markdowns.len() as u32;

  let det = pdf_inspector::detect_pdf(path).map_err(|e| e.to_string())?;

  let mut ocr_set: Vec<u32> = ocr_pages
    .into_iter()
    .filter(|p| (1..=page_count).contains(p))
    .collect();
  ocr_set.sort_unstable();
  ocr_set.dedup();

  // Resolve the OCR provider whenever OCR is enabled in settings. If OCR is
  // disabled, or no provider is configured, the conversion still proceeds —
  // those pages are skipped and recorded instead of aborting the whole
  // document.
  const OCR_DISABLED_REASON: &str = "OCR is disabled in settings";
  const NO_PROVIDER_REASON: &str = "no OCR provider configured";
  let app_settings = settings::get_app_settings(app)?;
  let ocr_mode = app_settings.ocr_mode;
  let mut resolved: Option<(String, String, String)> = None;

  // Force modes: add every page to the OCR set.
  if ocr_mode.is_force() {
    for p in 1..=page_count {
      if !ocr_set.contains(&p) {
        ocr_set.push(p);
      }
    }
    ocr_set.sort_unstable();
    ocr_set.dedup();
  }

  // For AI-based modes, resolve the remote provider.
  if !ocr_mode.is_local() {
    let vendors = settings::get_ocr_config(app)?;
    if let Some((vendor, model)) = resolve_provider(&vendors) {
      let key = settings::api_key_for(app, &vendor.id)?
        .ok_or_else(|| format!("The API Key of supplier '{}' is empty", vendor.name))?;
      resolved = Some((vendor.base_url.clone(), model.name.clone(), key));
    }
  }

  // Detection can classify a document as Mixed (image pages present) without
  // flagging any page for OCR. Always record pages whose local text extraction
  // produced nothing — those are the image-only pages the detector missed — so
  // `pages_needing_ocr` reflects the real situation regardless of the OCR
  // toggle or whether a provider was resolved.
  for (i, md) in page_markdowns.iter().enumerate() {
    let page_1 = (i + 1) as u32;
    if md.trim().is_empty() && !ocr_set.contains(&page_1) {
      ocr_set.push(page_1);
    }
  }
  ocr_set.sort_unstable();
  ocr_set.dedup();

  let (resolved, skipped_pages, skip_reason): (
    Option<(String, String, String)>,
    Vec<u32>,
    &'static str,
  ) = if ocr_set.is_empty() {
    (None, Vec::new(), NO_PROVIDER_REASON)
  } else if !ocr_mode.is_enabled() {
    (None, ocr_set.clone(), OCR_DISABLED_REASON)
  } else if ocr_mode.is_local() {
    // Local OCR: no remote provider needed.
    (None, Vec::new(), NO_PROVIDER_REASON)
  } else if let Some(r) = resolved {
    // AI-based modes with a configured provider.
    (Some(r), Vec::new(), NO_PROVIDER_REASON)
  } else {
    (None, ocr_set.clone(), NO_PROVIDER_REASON)
  };

  let client = Client::builder()
    .timeout(Duration::from_secs(300))
    .connect_timeout(Duration::from_secs(30))
    .build()
    .map_err(|e| format!("HTTP client initialization failed: {e}"))?;

  let info = DetectResult {
    pdf_type: PdfTypeDto::from(det.pdf_type),
    confidence: det.confidence,
    page_count,
    pages_needing_ocr: ocr_set.clone(),
    title: det.title.clone(),
    has_encoding_issues: !ocr_set.is_empty() || ext.needs_ocr_flags.iter().any(|&f| f),
    layout: LayoutDto {
      is_complex: ext.is_complex,
      pages_with_tables: ext.pages_with_tables,
      pages_with_columns: ext.pages_with_columns,
    },
  };

  let ocr_configured = resolved.is_some() || ocr_mode.is_local();

  let session = HybridSession {
    pages: page_markdowns,
    info: info.clone(),
    resolved,
    client,
    ocr_results: HashMap::new(),
    skipped_pages,
    failed_pages: Vec::new(),
    skip_reason,
    start,
    ocr_mode,
  };

  let mut map = store.lock();
  let now = Instant::now();
  map.retain(|_, s| now.duration_since(s.start) < SESSION_MAX_AGE);
  while map.len() >= SESSION_MAX_COUNT {
    let oldest = map
      .iter()
      .min_by_key(|(_, s)| s.start)
      .map(|(k, _)| k.clone());
    if let Some(k) = oldest {
      map.remove(&k);
    } else {
      break;
    }
  }
  let session_id = Uuid::new_v4().to_string();
  map.insert(session_id.clone(), session);

  Ok(HybridSessionInfo {
    session_id,
    ocr_configured,
    info,
  })
}

/// Run one page through the configured OCR provider and cache its markdown.
/// Provider failures degrade to a comment (same as the previous batch flow) so
/// a single bad page never aborts the whole document.
pub async fn ocr_page_in_session(
  store: &HybridStore,
  session_id: &str,
  page: u32,
  image_png: &str,
  app: &AppHandle,
) -> Result<String, String> {
  let (client, resolved, ocr_mode) = {
    let map = store.lock();
    let session = map
      .get(session_id)
      .ok_or_else(|| "The conversion session does not exist or has expired".to_string())?;
    let resolved = session.resolved.clone();
    let ocr_mode = session.ocr_mode;
    (session.client.clone(), resolved, ocr_mode)
  };

  let md = if ocr_mode.is_local() {
    // Use local OCR engine
    match local_ocr_page(app, page, image_png) {
      Ok(m) => m,
      Err(e) => {
        let mut map = store.lock();
        if let Some(session) = map.get_mut(session_id) {
          session.failed_pages.push(page);
        }
        format!("<!-- OCR failed (page {page}): {e} -->")
      }
    }
  } else {
    // Use remote OCR provider (Ai, NonTextOnly, ForceOcr)
    let (base_url, model_id, api_key) =
      resolved.ok_or_else(|| "No available OCR supplier configured".to_string())?;
    match ocr_page(
      &client,
      &base_url,
      &model_id,
      &api_key,
      page,
      OCR_PROMPT,
      "image/png",
      image_png,
    )
    .await
    {
      Ok(m) => m,
      Err(e) => {
        let mut map = store.lock();
        if let Some(session) = map.get_mut(session_id) {
          session.failed_pages.push(page);
        }
        format!("<!-- OCR failed (page {page}): {e} -->")
      }
    }
  };

  let mut map = store.lock();
  if let Some(session) = map.get_mut(session_id) {
    session.ocr_results.insert(page, md.clone());
  }
  Ok(md)
}

/// Run one page through the local OCR engine.
fn local_ocr_page(app: &AppHandle, page: u32, image_png: &str) -> Result<String, String> {
  // Decode the PNG image from base64
  let image_data = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, image_png)
    .map_err(|e| format!("Failed to decode base64 image: {e}"))?;

  // Create the local OCR engine
  let engine = create_local_ocr_engine(app)?;

  // Use the configured text separator.
  let sep = settings::get_app_settings(app)?.text_separator;

  // Run OCR
  let text = engine.recognize_from_png(&image_data, &sep)?;

  if text.trim().is_empty() {
    return Err(format!("Local OCR returned no content (page {page})"));
  }

  Ok(text.trim().to_string())
}

/// Reassemble text + OCR pages in document order and drop the session.
pub fn finish_session(store: &HybridStore, session_id: &str) -> Result<ConvertResult, String> {
  let mut map = store.lock();
  let session = map
    .remove(session_id)
    .ok_or_else(|| "The conversion session does not exist or has expired".to_string())?;

  let page_count = session.info.page_count;
  let skipped: HashSet<u32> = session.skipped_pages.iter().copied().collect();
  let mut parts = Vec::with_capacity(page_count as usize);
  for i in 0..page_count {
    let page_1 = i + 1;
    let md = if skipped.contains(&page_1) {
      format!(
        "<!-- OCR skipped (page {page_1}): {} -->",
        session.skip_reason
      )
    } else {
      match session.ocr_results.get(&page_1) {
        Some(m) => m.clone(),
        None => session
          .pages
          .get(i as usize)
          .map(|p| p.trim().to_string())
          .unwrap_or_default(),
      }
    };
    parts.push(format!("{}\n\n{md}", page_marker(page_1)));
  }

  Ok(ConvertResult {
    info: session.info,
    markdown: parts.join("\n\n"),
    processing_time_ms: session.start.elapsed().as_millis() as u64,
    skipped_pages: session.skipped_pages,
    failed_pages: session.failed_pages,
  })
}

/// Abandon a session (cancelled / error before finishing).
pub fn abort_session(store: &HybridStore, session_id: &str) -> Result<(), String> {
  store.lock().remove(session_id);
  Ok(())
}

/// Map a standalone image file extension to the MIME type used in AI vision
/// requests. Only formats the app accepts for image conversion are allowed.
fn image_mime_for_ext(ext: &str) -> Result<&'static str, String> {
  match ext.trim().to_ascii_lowercase().trim_start_matches('.') {
    "png" => Ok("image/png"),
    "jpg" | "jpeg" => Ok("image/jpeg"),
    other => Err(format!("Unsupported image type: .{other}")),
  }
}

/// Convert one standalone image file (PNG / JPEG) to Markdown using the OCR
/// engine selected by the current mode.
///
/// Images never have a PDF text layer, so the non-text modes behave like their
/// force counterparts; `disabled` is an error because there is nothing else to
/// extract from a bare image.
pub async fn convert_image_to_md(app: &AppHandle, path: &str) -> Result<OcrImageResult, String> {
  let start = Instant::now();
  let ext = std::path::Path::new(path)
    .extension()
    .and_then(|e| e.to_str())
    .unwrap_or("");
  let mime = image_mime_for_ext(ext)?;
  let mode = settings::get_app_settings(app)?.ocr_mode;
  if !mode.is_enabled() {
    return Err("OCR is disabled in settings".to_string());
  }

  let markdown = if mode.is_local() {
    // Local PaddleOCR is CPU-bound model inference — run it off the async
    // runtime so concurrent conversions never block each other's futures.
    let sep = settings::get_app_settings(app)?.text_separator;
    let app = app.clone();
    let path = path.to_string();
    tauri::async_runtime::spawn_blocking(move || {
      let image_data =
        std::fs::read(&path).map_err(|e| format!("Failed to read image file: {e}"))?;
      let engine = create_local_ocr_engine(&app)?;
      let text = engine.recognize_bytes(&image_data, &sep)?;
      if text.trim().is_empty() {
        return Err("Local OCR returned no content".to_string());
      }
      Ok(text.trim().to_string())
    })
    .await
    .map_err(|e| format!("Local OCR task failed: {e}"))??
  } else {
    // AI-based modes: route through the configured remote vision provider.
    let provider = resolve_remote_provider(app)?
      .ok_or_else(|| "No available OCR supplier configured".to_string())?;
    // Reading and encoding the image is blocking work — keep it off the
    // async runtime just like local inference.
    let path = path.to_string();
    let encoded = tauri::async_runtime::spawn_blocking(move || {
      let image_data =
        std::fs::read(&path).map_err(|e| format!("Failed to read image file: {e}"))?;
      Ok::<_, String>(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        image_data,
      ))
    })
    .await
    .map_err(|e| format!("Failed to prepare image: {e}"))??;
    ocr_page(
      &provider.client,
      &provider.base_url,
      &provider.model_id,
      &provider.api_key,
      0,
      OCR_PROMPT,
      mime,
      &encoded,
    )
    .await?
  };

  Ok(OcrImageResult {
    markdown,
    engine: (if mode.is_local() { "local" } else { "ai" }).to_string(),
    duration_ms: start.elapsed().as_millis() as u64,
    png_base64: None,
    saved_path: None,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn image_mime_for_ext_accepts_supported_types() {
    assert_eq!(image_mime_for_ext("png"), Ok("image/png"));
    assert_eq!(image_mime_for_ext("jpg"), Ok("image/jpeg"));
    assert_eq!(image_mime_for_ext("jpeg"), Ok("image/jpeg"));
    // Case / leading-dot tolerance.
    assert_eq!(image_mime_for_ext(".JPG"), Ok("image/jpeg"));
    assert_eq!(image_mime_for_ext("PNG"), Ok("image/png"));
  }

  #[test]
  fn image_mime_for_ext_rejects_unsupported_types() {
    assert!(image_mime_for_ext("webp").is_err());
    assert!(image_mime_for_ext("heic").is_err());
    assert!(image_mime_for_ext("pdf").is_err());
    assert!(image_mime_for_ext("").is_err());
  }
}
