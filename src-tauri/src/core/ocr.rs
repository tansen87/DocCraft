use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::Client;
use tauri::AppHandle;
use uuid::Uuid;

use crate::core::grid_rebuild;
use crate::core::page_marker::page_marker;
use crate::core::settings;
use crate::models::{
  ConvertResult, DetectResult, HybridSessionInfo, LayoutDto, OcrVendor, PdfTypeDto,
};

/// Prompt sent to the vision model for every OCR page.
const OCR_PROMPT: &str = "你是一个专业的OCR引擎.请完整识别这张PDF页面图片中的内容,并转换为规范的Markdown输出: 保留标题层级(#、##)、段落、列表、表格(使用GFM表格语法)等结构.只输出识别后的Markdown内容,不要添加任何解释或前言.";

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

/// Pick the provider used for OCR: the first configured vendor that has a
/// stored key and at least one model.
fn resolve_provider(vendors: &[OcrVendor]) -> Option<(&OcrVendor, &crate::models::OcrModel)> {
  vendors
    .iter()
    .filter(|v| v.api_key.is_some())
    .find_map(|v| v.models.first().map(|m| (v, m)))
}

/// Send one page image to an OpenAI-compatible `/chat/completions` endpoint
/// and return the extracted markdown.
async fn ocr_page(
  client: &Client,
  base_url: &str,
  model_id: &str,
  api_key: &str,
  page: u32,
  image_png: &str,
) -> Result<String, String> {
  let url = completions_url(base_url);
  let body = serde_json::json!({
    "model": model_id,
    "temperature": 0,
    "max_tokens": 4096,
    "messages": [{
      "role": "user",
      "content": [
        { "type": "text", "text": OCR_PROMPT },
        {
          "type": "image_url",
          "image_url": { "url": format!("data:image/png;base64,{image_png}") }
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
    return Err(format!("OCR 服务返回 {status}: {snippet}"));
  }

  let json: serde_json::Value = response
    .json()
    .await
    .map_err(|e| format!("OCR 响应解析失败: {e}"))?;

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
    Some(t) if !t.trim().is_empty() => Ok(t.trim().to_string()),
    _ => Err(format!("OCR service returned no content (page {page})")),
  }
}

/// An in-flight hybrid conversion. Text pages are extracted once at start and
/// kept as plain markdown; OCR pages are streamed in one at a time so only a
/// single page image (not the whole document) is ever in memory.
pub struct HybridSession {
  /// Per-page markdown for the whole document (0-indexed), matching `info.page_count`.
  pub pages: Vec<String>,
  /// Detection metadata, computed once at start.
  pub info: DetectResult,
  /// `(base_url, model_id, api_key)` when at least one page uses OCR.
  pub resolved: Option<(String, String, String)>,
  pub client: Client,
  /// OCR results keyed by 1-indexed page number.
  pub ocr_results: HashMap<u32, String>,
  /// Pages that needed OCR but were skipped because no provider is configured.
  pub skipped_pages: Vec<u32>,
  /// Pages whose OCR request failed (degraded to a placeholder comment).
  pub failed_pages: Vec<u32>,
  pub start: Instant,
}

/// Managed store of live hybrid sessions keyed by a generated session id.
pub struct HybridStore(pub Mutex<HashMap<String, HybridSession>>);

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

  let pages =
    pdf_inspector::extract_pages_markdown(path, None).map_err(|e| format!("文本提取失败: {e}"))?;
  let page_count = pages.pages.len() as u32;

  // Recover line breaks on text pages.
  let items =
    pdf_inspector::extract_text_with_positions(path).map_err(|e| format!("文本提取失败: {e}"))?;
  let page_markdowns: Vec<String> =
    grid_rebuild::rebuild_pages(&pages.pages, &items, &pages.pages_with_tables);

  let det = pdf_inspector::detect_pdf(path).map_err(|e| e.to_string())?;

  let mut ocr_set: Vec<u32> = ocr_pages
    .into_iter()
    .filter(|p| (1..=page_count).contains(p))
    .collect();
  ocr_set.sort_unstable();
  ocr_set.dedup();

  // Resolve the OCR provider when pages need OCR. If none is configured, the
  // conversion still proceeds — those pages are skipped and recorded instead of
  // aborting the whole document.
  let (resolved, skipped_pages): (Option<(String, String, String)>, Vec<u32>) =
    if !ocr_set.is_empty() {
      let vendors = settings::get_ocr_config(app)?;
      match resolve_provider(&vendors) {
        Some((vendor, model)) => {
          let key = settings::api_key_for(app, &vendor.id)?
            .ok_or_else(|| format!("供应商「{}」的 API Key 为空", vendor.name))?;
          (
            Some((vendor.base_url.clone(), model.id.clone(), key)),
            Vec::new(),
          )
        }
        None => (None, ocr_set.clone()),
      }
    } else {
      (None, Vec::new())
    };

  let client = Client::builder()
    .timeout(Duration::from_secs(300))
    .connect_timeout(Duration::from_secs(30))
    .build()
    .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;

  let info = DetectResult {
    pdf_type: PdfTypeDto::from(det.pdf_type),
    confidence: det.confidence,
    page_count,
    pages_needing_ocr: ocr_set.clone(),
    title: det.title.clone(),
    has_encoding_issues: !ocr_set.is_empty() || pages.pages.iter().any(|p| p.needs_ocr),
    layout: LayoutDto {
      is_complex: pages.is_complex,
      pages_with_tables: pages.pages_with_tables.clone(),
      pages_with_columns: pages.pages_with_columns.clone(),
    },
  };

  let ocr_configured = resolved.is_some();

  let session = HybridSession {
    pages: page_markdowns,
    info: info.clone(),
    resolved,
    client,
    ocr_results: HashMap::new(),
    skipped_pages,
    failed_pages: Vec::new(),
    start,
  };

  let mut map = store.0.lock().unwrap();
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
) -> Result<String, String> {
  let (client, (base_url, model_id, api_key)) = {
    let map = store.0.lock().unwrap();
    let session = map
      .get(session_id)
      .ok_or_else(|| "转换会话不存在或已过期".to_string())?;
    let resolved = session
      .resolved
      .clone()
      .ok_or_else(|| "未配置可用的 OCR 供应商".to_string())?;
    (session.client.clone(), resolved)
  };

  let md = match ocr_page(&client, &base_url, &model_id, &api_key, page, image_png).await {
    Ok(m) => m,
    Err(e) => {
      let mut map = store.0.lock().unwrap();
      if let Some(session) = map.get_mut(session_id) {
        session.failed_pages.push(page);
      }
      format!("<!-- OCR failed (page {page}): {e} -->")
    }
  };

  let mut map = store.0.lock().unwrap();
  if let Some(session) = map.get_mut(session_id) {
    session.ocr_results.insert(page, md.clone());
  }
  Ok(md)
}

/// Reassemble text + OCR pages in document order and drop the session.
pub fn finish_session(store: &HybridStore, session_id: &str) -> Result<ConvertResult, String> {
  let mut map = store.0.lock().unwrap();
  let session = map
    .remove(session_id)
    .ok_or_else(|| "转换会话不存在或已过期".to_string())?;

  let page_count = session.info.page_count;
  let skipped: HashSet<u32> = session.skipped_pages.iter().copied().collect();
  let mut parts = Vec::with_capacity(page_count as usize);
  for i in 0..page_count {
    let page_1 = i + 1;
    let md = if skipped.contains(&page_1) {
      format!("<!-- OCR skipped (page {page_1}): no OCR provider configured -->")
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
  store.0.lock().unwrap().remove(session_id);
  Ok(())
}
