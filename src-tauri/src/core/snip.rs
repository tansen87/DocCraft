use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use image::{RgbaImage, imageops::crop_imm};
use png::{BitDepth, ColorType, Compression, Encoder};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use xcap::Monitor;

use crate::core::{paragraph, settings};
use crate::models::{
  GuidedMergeConfig, ImageTableRequest, ImageTableResult, MonitorSnapshot, OcrImageResult,
  ParagraphMode, ShotRegion, WindowInfo,
};

/// Managed cache of full-monitor snapshots between `screenshot_begin` and the
/// follow-up `screenshot_ocr` / `screenshot_cancel`.
pub struct SnipStore(pub Mutex<HashMap<u32, RgbaImage>>);

impl SnipStore {
  /// Lock the snapshot map, recovering from poisoning like [`crate::core::ocr::HybridStore`].
  fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u32, RgbaImage>> {
    self.0.lock().unwrap_or_else(|e| e.into_inner())
  }
}

impl Default for SnipStore {
  fn default() -> Self {
    Self(Mutex::new(HashMap::new()))
  }
}

/// The currently registered global screenshot hotkey, kept so settings
/// changes can unregister exactly what was registered before.
pub struct SnipHotkey(pub Mutex<Option<Shortcut>>);

impl Default for SnipHotkey {
  fn default() -> Self {
    Self(Mutex::new(None))
  }
}

/// Re-register the global screenshot hotkey from persisted settings. Called at
/// startup and after every settings save; an empty value unregisters instead.
/// The hotkey handler (see `lib.rs`) emits `snip:hotkey` to the frontend.
pub fn apply_hotkey(app: &AppHandle) -> Result<(), String> {
  let raw = settings::get_app_settings(app)?.screenshot_hotkey;
  let gs = app.global_shortcut();
  let state = app.state::<SnipHotkey>();
  let mut current = state.0.lock().unwrap_or_else(|e| e.into_inner());

  if let Some(prev) = current.take() {
    let _ = gs.unregister(prev);
  }

  let Some(raw) = raw.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
    // Hotkey explicitly disabled.
    return Ok(());
  };
  let shortcut: Shortcut = raw
    .parse()
    .map_err(|e| format!("Invalid screenshot hotkey '{raw}': {e}"))?;
  gs.register(shortcut)
    .map_err(|e| format!("Failed to register screenshot hotkey '{raw}': {e}"))?;
  *current = Some(shortcut);
  Ok(())
}

/// Get the current cursor position in virtual-screen coordinates.
/// Uses the Windows API directly (no extra crate needed).
#[cfg(target_os = "windows")]
fn cursor_pos() -> (i32, i32) {
  use windows_sys::Win32::Foundation::POINT;
  use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
  let mut pt = POINT { x: 0, y: 0 };
  let _ = unsafe { GetCursorPos(&mut pt) };
  (pt.x, pt.y)
}

#[cfg(not(target_os = "windows"))]
fn cursor_pos() -> (i32, i32) {
  (0, 0)
}

/// Encode raw RGBA data as a PNG with fast (low-level) compression. Used for
/// the persisted selection crop - the OCR engine reads it back from disk.
fn encode_fast_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
  let mut buf = Vec::new();
  let mut encoder = Encoder::new(&mut buf, width, height);
  encoder.set_compression(Compression::Fast);
  encoder.set_color(ColorType::Rgba);
  encoder.set_depth(BitDepth::Eight);
  let mut writer = encoder
    .write_header()
    .map_err(|e| format!("PNG header write failed: {e}"))?;
  writer
    .write_image_data(rgba)
    .map_err(|e| format!("PNG data write failed: {e}"))?;
  writer
    .finish()
    .map_err(|e| format!("PNG finish failed: {e}"))?;
  Ok(buf)
}

/// Encode a full-monitor frame as a JPEG preview for the overlay background.
/// Much faster and smaller than PNG; fidelity is irrelevant because region
/// cropping always uses the raw RGBA frame kept in [`SnipStore`]. Screen
/// captures are opaque, so dropping alpha is lossless here.
fn encode_preview_jpeg(frame: &RgbaImage) -> Result<Vec<u8>, String> {
  let rgb = image::DynamicImage::ImageRgba8(frame.clone()).to_rgb8();
  let mut buf = Cursor::new(Vec::new());
  let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 85);
  rgb
    .write_with_encoder(encoder)
    .map_err(|e| format!("JPEG encode failed: {e}"))?;
  Ok(buf.into_inner())
}

fn base64_encode(data: &[u8]) -> String {
  base64::Engine::encode(&base64::engine::general_purpose::STANDARD, data)
}

/// Cap the longer side of a screenshot thumbnail at this many pixels.
const SNIP_THUMB_MAX_PX: u32 = 480;

/// Downscale an image so its longer side is at most [`SNIP_THUMB_MAX_PX`]
/// (never upscales). Used to keep the IPC result payload small.
fn thumbnail_rgba(img: &RgbaImage) -> RgbaImage {
  use image::imageops::FilterType;
  let long = img.width().max(img.height());
  if long <= SNIP_THUMB_MAX_PX {
    return img.clone();
  }
  let scale = f64::from(SNIP_THUMB_MAX_PX) / f64::from(long);
  let nw = ((f64::from(img.width()) * scale).round() as u32).max(1);
  let nh = ((f64::from(img.height()) * scale).round() as u32).max(1);
  image::imageops::resize(img, nw, nh, FilterType::Triangle)
}

/// Normalize a raw selection against the monitor frame. Returns the clamped
/// `(x, y, width, height)` in physical pixels, or `None` when the selection is
/// empty / degenerate (< 4 px on a side - treated as an accidental click).
/// The frontend always sends a normalized top-left origin with positive size.
fn clamp_region(
  region: &ShotRegion,
  frame_width: u32,
  frame_height: u32,
) -> Option<(u32, u32, u32, u32)> {
  const MIN_REGION_PX: i64 = 4;
  let fw = i64::from(region.width);
  let fh = i64::from(region.height);
  let fx = i64::from(region.x);
  let fy = i64::from(region.y);

  // Intersect with the frame bounds.
  let left = fx.clamp(0, i64::from(frame_width));
  let top = fy.clamp(0, i64::from(frame_height));
  let right = (fx + fw).clamp(0, i64::from(frame_width));
  let bottom = (fy + fh).clamp(0, i64::from(frame_height));

  let cw = right - left;
  let ch = bottom - top;
  if cw < MIN_REGION_PX || ch < MIN_REGION_PX {
    return None;
  }
  Some((left as u32, top as u32, cw as u32, ch as u32))
}

/// Find the monitor whose bounding box contains the cursor.
fn monitor_under_cursor() -> Result<Monitor, String> {
  let (cx, cy) = cursor_pos();
  let monitors = Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {e}"))?;
  for m in &monitors {
    let mx = m.x().map_err(|e| format!("Failed to query monitor: {e}"))?;
    let my = m.y().map_err(|e| format!("Failed to query monitor: {e}"))?;
    let mw = m
      .width()
      .map_err(|e| format!("Failed to query monitor: {e}"))?;
    let mh = m
      .height()
      .map_err(|e| format!("Failed to query monitor: {e}"))?;
    if cx >= mx && cx < mx + mw as i32 && cy >= my && cy < my + mh as i32 {
      return Ok(m.clone());
    }
  }
  Err(format!("No monitor contains cursor ({cx},{cy})"))
}

/// Capture the screen under the cursor and return its snapshot + raw frame.
/// Runs inside `spawn_blocking`.
fn capture_under_cursor() -> Result<(MonitorSnapshot, (u32, RgbaImage)), String> {
  let m = monitor_under_cursor()?;
  let id = m
    .id()
    .map_err(|e| format!("Failed to query monitor: {e}"))?;
  let x = m.x().map_err(|e| format!("Failed to query monitor: {e}"))?;
  let y = m.y().map_err(|e| format!("Failed to query monitor: {e}"))?;
  let scale = m
    .scale_factor()
    .map_err(|e| format!("Failed to query monitor: {e}"))?;
  let frame = m
    .capture_image()
    .map_err(|e| format!("Screen capture failed: {e}"))?;

  let width = frame.width();
  let height = frame.height();
  // JPEG preview only - cropping/OCR always uses the raw frame in SnipStore.
  let preview = encode_preview_jpeg(&frame)?;
  let data_url = format!("data:image/jpeg;base64,{}", base64_encode(&preview));

  Ok((
    MonitorSnapshot {
      id,
      x,
      y,
      width,
      height,
      scale_factor: scale as f64,
      data_url,
    },
    (id, frame),
  ))
}

/// Capture the screen under the cursor.  Returns a single-element vec so the
/// existing frontend (which expects a list) works without changes.
pub async fn begin_screenshot(app: &AppHandle) -> Result<Vec<MonitorSnapshot>, String> {
  let (snap, entry) = tauri::async_runtime::spawn_blocking(capture_under_cursor)
    .await
    .map_err(|e| format!("Screenshot task failed: {e}"))??;

  let store = app.state::<SnipStore>();
  {
    let mut map = store.lock();
    map.clear();
    map.insert(entry.0, entry.1);
  }

  Ok(vec![snap])
}

/// Like `begin_screenshot` but emits `snip:ready` / `snip:error` events
/// instead of returning, so the hotkey handler avoids an IPC round-trip.
pub async fn capture_and_emit(app: AppHandle) {
  match begin_screenshot(&app).await {
    Ok(snapshots) => {
      if let Err(e) = app.emit("snip:ready", &snapshots) {
        eprintln!("capture_and_emit: failed to emit snip:ready: {e}");
        end_screenshot_session(&app);
      }
    }
    Err(e) => {
      eprintln!("capture_and_emit: screenshot capture failed: {e}");
      let _ = app.emit("snip:error", &e);
    }
  }
}

/// Directory where selected regions are persisted (enables retry / export
/// exactly like imported files).
fn screenshots_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
    .join("screenshots");
  std::fs::create_dir_all(&dir)
    .map_err(|e| format!("Failed to create screenshot directory: {e}"))?;
  Ok(dir)
}

/// Crop the selected region out of the cached snapshot, run the configured
/// OCR engine over it **from memory** and persist the PNG copy afterwards.
///
/// Consumes the snapshot for the given monitor; any other cached monitors are
/// dropped afterwards by [`end_screenshot_session`] (invoked by the command
/// layer regardless of success).
pub async fn screenshot_ocr(app: &AppHandle, region: ShotRegion) -> Result<OcrImageResult, String> {
  let settings = settings::get_app_settings(app)?;
  let mode = settings.ocr_mode;
  let paragraph_mode = settings.paragraph_mode;
  if !mode.is_enabled() {
    return Err("OCR is disabled in settings".to_string());
  }

  let frame = {
    let store = app.state::<SnipStore>();
    let mut map = store.lock();
    map
      .remove(&region.monitor_id)
      .ok_or_else(|| "Screenshot session expired - please capture again".to_string())?
  };

  let start = Instant::now();
  let dir = screenshots_dir(app)?;
  let stamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis())
    .unwrap_or_default();
  let path = dir.join(format!("shot-{stamp}.png"));

  // Crop off the async runtime; also prepare the small IPC thumbnail here so
  // the whole payload is ready without touching the disk.
  let crop_start = Instant::now();
  let (cropped, thumb_b64) =
    tauri::async_runtime::spawn_blocking(move || -> Result<(RgbaImage, String), String> {
      let Some((x, y, w, h)) = clamp_region(&region, frame.width(), frame.height()) else {
        return Err("Selection area is too small".to_string());
      };
      let cropped = crop_imm(&frame, x, y, w, h).to_image();
      // The IPC payload only needs a list thumbnail - downsample to keep the
      // event small. Retry/export always re-read the full-resolution file.
      let thumb = thumbnail_rgba(&cropped);
      let thumb_png = encode_fast_png(thumb.as_raw(), thumb.width(), thumb.height())?;
      Ok((cropped, base64_encode(&thumb_png)))
    })
    .await
    .map_err(|e| format!("Screenshot task failed: {e}"))??;

  let crop_ms = crop_start.elapsed().as_millis() as u64;
  let infer_start = Instant::now();

  let (markdown, confidence, save_ms) = if mode.is_local() {
    let app = app.clone();
    let saved_path = path.clone();
    let sep = settings::get_app_settings(&app)?.text_separator;
    // Screenshot-dedicated engine (S-2): never queues behind batch OCR tasks.
    // Acquired inside spawn_blocking so a cold model load cannot stall the
    // async runtime (S-4).
    tauri::async_runtime::spawn_blocking(move || -> Result<(String, Option<f32>, u64), String> {
      let engine = crate::core::ocr::acquire_snip_ocr_engine(&app)?;
      // Feed the in-memory crop straight to the engine - no PNG encode >
      // write > read > decode round-trip on the hot path (S-3).
      let image = image::DynamicImage::ImageRgba8(cropped.clone());
      let (text, confidence) = {
        let eng = engine.lock().unwrap_or_else(|e| e.into_inner());
        eng.recognize_image_with_confidence(&image, &sep)?
      };
      // Persist the full-resolution copy after recognition so retry / export
      // behave exactly like an imported file.
      let save_start = Instant::now();
      let png = encode_fast_png(cropped.as_raw(), cropped.width(), cropped.height())?;
      std::fs::write(&saved_path, &png).map_err(|e| format!("Failed to save screenshot: {e}"))?;
      let save_ms = save_start.elapsed().as_millis() as u64;
      if text.trim().is_empty() {
        return Err("Local OCR returned no content".to_string());
      }
      // Screenshot OCR has no geometry - run the textual heuristics so the
      // output matches the user's paragraph policy (same as PDF batch OCR).
      let text = crate::core::ocr::apply_ocr_cleanup(&app, &text)?;
      let text = paragraph::apply_text(&text, paragraph_mode);
      Ok((text.trim().to_string(), Some(confidence), save_ms))
    })
    .await
    .map_err(|e| format!("Local OCR task failed: {e}"))??
  } else {
    let saved_path = path.clone();
    let save_start = Instant::now();
    let png_b64 = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
      let png = encode_fast_png(cropped.as_raw(), cropped.width(), cropped.height())?;
      std::fs::write(&saved_path, &png).map_err(|e| format!("Failed to save screenshot: {e}"))?;
      Ok(base64_encode(&png))
    })
    .await
    .map_err(|e| format!("Screenshot task failed: {e}"))??;
    let provider = crate::core::ocr::resolve_remote_provider(app)?
      .ok_or_else(|| "No available OCR supplier configured".to_string())?;
    let prompt = crate::core::ocr::effective_ai_ocr_prompt(app)?;
    let markdown = crate::core::ocr::ai_recognize_image(&provider, &png_b64, &prompt).await?;
    // Deterministic post-processing on top of the prompt-level merge, matching
    // the chosen paragraph policy (same as PDF batch AI OCR).
    let markdown = crate::core::ocr::apply_ocr_cleanup(app, &markdown)?;
    let markdown = paragraph::apply_text(&markdown, paragraph_mode);
    (markdown, None, save_start.elapsed().as_millis() as u64)
  };
  let infer_ms = infer_start.elapsed().as_millis() as u64 - save_ms;

  Ok(OcrImageResult {
    markdown,
    engine: (if mode.is_local() { "local" } else { "ai" }).to_string(),
    duration_ms: start.elapsed().as_millis() as u64,
    png_base64: Some(thumb_b64),
    saved_path: Some(path.to_string_lossy().into_owned()),
    crop_ms: Some(crop_ms),
    infer_ms: Some(infer_ms),
    save_ms: Some(save_ms),
    ocr_confidence: confidence,
  })
}

/// Drop every cached snapshot.
pub fn end_screenshot_session(app: &AppHandle) {
  app.state::<SnipStore>().lock().clear();
}

/// Detect the top-level window under the cursor.
#[cfg(target_os = "windows")]
fn window_under_cursor() -> Result<WindowInfo, String> {
  use windows_sys::Win32::Foundation::{POINT, RECT};
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetCursorPos, GetWindowRect, GetWindowTextW, WindowFromPoint,
  };

  unsafe {
    let mut pt = POINT { x: 0, y: 0 };
    if GetCursorPos(&mut pt) == 0 {
      return Err("Failed to query cursor position".into());
    }

    let hwnd = WindowFromPoint(pt);
    if hwnd.is_null() {
      return Err("No window under cursor".into());
    }

    let mut title_buf = [0u16; 512];
    let title_len = GetWindowTextW(hwnd, title_buf.as_mut_ptr(), title_buf.len() as i32);
    let title = String::from_utf16_lossy(&title_buf[..title_len as usize]);

    let mut class_buf = [0u16; 256];
    let class_len = GetClassNameW(hwnd, class_buf.as_mut_ptr(), class_buf.len() as i32);
    let class_name = String::from_utf16_lossy(&class_buf[..class_len as usize]);

    let mut rect = RECT {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    };
    GetWindowRect(hwnd, &mut rect);

    Ok(WindowInfo {
      title,
      class_name,
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    })
  }
}

#[cfg(not(target_os = "windows"))]
fn window_under_cursor() -> Result<WindowInfo, String> {
  Err("Window detection is only available on Windows".into())
}

/// Tauri command exposing the window currently under the cursor.
#[tauri::command]
pub async fn get_window_under_cursor() -> Result<WindowInfo, String> {
  window_under_cursor()
}

/// Extract a GFM table from an image using OCR + user-drawn vertical lines.
/// Respects the OCR mode setting:
///   - Local mode: use PaddleOCR text blocks + column cutting.
///   - AI mode: send image + line percentages to the AI vision model.
pub async fn ocr_image_table(
  app: &AppHandle,
  request: ImageTableRequest,
) -> Result<ImageTableResult, String> {
  use crate::core::ocr::{ai_recognize_table, resolve_remote_provider};
  let start = Instant::now();
  let mode = settings::get_app_settings(app)?.ocr_mode;
  if !mode.is_enabled() {
    return Err("OCR is disabled in settings".to_string());
  }

  let img = image::open(&request.image_path).map_err(|e| format!("Failed to load image: {e}"))?;
  let img_width = img.width() as f64;
  let img_height = img.height() as f64;

  if mode.is_local() {
    let markdown = tauri::async_runtime::spawn_blocking({
      let app = app.clone();
      let path = request.image_path.clone();
      let vertical_px: Vec<f64> = request
        .vertical_lines
        .iter()
        .map(|p| *p * img_width / 100.0)
        .collect();
      let horizontal_px: Vec<f64> = request
        .horizontal_lines
        .unwrap_or_default()
        .iter()
        .map(|p| *p * img_height / 100.0)
        .collect();
      let sep = settings::get_app_settings(&app)?.text_separator;
      let paragraph_mode = settings::get_app_settings(&app)?.paragraph_mode;
      // Shared/resident engine.
      let cache = app.state::<crate::core::ocr::OcrEngineCache>();
      let engine = crate::core::ocr::acquire_local_ocr_engine(&app, &cache)?;
      move || -> Result<String, String> {
        let image_data =
          std::fs::read(&path).map_err(|e| format!("Failed to read image file: {e}"))?;
        let recognition = {
          let eng = engine.lock().unwrap_or_else(|e| e.into_inner());
          eng.recognize_png_blocks(&image_data)?
        };
        Ok(extract_table_from_ocr_blocks(
          &recognition,
          &vertical_px,
          &horizontal_px,
          img_width,
          img_height,
          &sep,
          paragraph_mode,
          request.guided.as_ref(),
        ))
      }
    })
    .await
    .map_err(|e| format!("OCR task failed: {e}"))??;

    Ok(ImageTableResult {
      markdown,
      engine: "local".to_string(),
      duration_ms: start.elapsed().as_millis() as u64,
    })
  } else {
    let provider = resolve_remote_provider(app)?
      .ok_or_else(|| "No available OCR supplier configured".to_string())?;

    let png_bytes =
      std::fs::read(&request.image_path).map_err(|e| format!("Failed to read image: {e}"))?;
    let png_b64 = base64_encode(&png_bytes);
    // The AI vision path already understands drawn horizontal separators
    // (same hints the PDF draw-table flow sends).
    let horizontal_pcts = request.horizontal_lines.unwrap_or_default();
    let draw_prompt = crate::core::ocr::effective_draw_table_prompt(app)?;

    let markdown = ai_recognize_table(
      &provider,
      0,
      &png_b64,
      &request.vertical_lines,
      &horizontal_pcts,
      &draw_prompt,
    )
    .await?;

    Ok(ImageTableResult {
      markdown,
      engine: "ai".to_string(),
      duration_ms: start.elapsed().as_millis() as u64,
    })
  }
}

/// Build a GFM table from OCR text blocks by cutting columns at the given
/// vertical pixel positions. Rows come either from user-drawn horizontal
/// lines (`horizontal_px` non-empty: each band is one row, topmost band =
/// header) or - when absent - are auto-grouped from OCR block positions.
fn extract_table_from_ocr_blocks(
  recognition: &crate::core::ocr::OcrRecognition,
  vertical_px: &[f64],
  horizontal_px: &[f64],
  img_width: f64,
  img_height: f64,
  separator: &str,
  paragraph_mode: ParagraphMode,
  guided: Option<&GuidedMergeConfig>,
) -> String {
  // Column boundaries: 0 + user lines + image width.
  let mut col_bounds: Vec<f64> = vec![0.0];
  col_bounds.extend(vertical_px.iter().copied());
  col_bounds.push(img_width);
  col_bounds.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
  let ncols = col_bounds.len().saturating_sub(1);
  if ncols == 0 {
    return String::new();
  }

  // Sort blocks by y (top > bottom), then x (left > right).
  let mut blocks: Vec<&crate::core::ocr::OcrBlock> = recognition.blocks.iter().collect();
  blocks.sort_by(|a, b| {
    a.top
      .partial_cmp(&b.top)
      .unwrap_or(std::cmp::Ordering::Equal)
      .then_with(|| {
        a.left
          .partial_cmp(&b.left)
          .unwrap_or(std::cmp::Ordering::Equal)
      })
  });
  if blocks.is_empty() {
    return String::new();
  }

  // Cut one sorted group of blocks into table columns.
  let cut_line_by_columns = |line: &[&crate::core::ocr::OcrBlock]| -> Vec<String> {
    (0..ncols)
      .map(|col| {
        let left = col_bounds[col];
        let right = col_bounds[col + 1];
        line
          .iter()
          .filter(|b| {
            let center = b.left + b.width / 2.0;
            center >= left - 1e-3 && center < right + 1e-3
          })
          .map(|b| b.text.as_str())
          .collect::<Vec<_>>()
          .join(separator)
      })
      .collect()
  };

  let data_rows: Vec<Vec<String>> = if horizontal_px.is_empty() {
    // No horizontal row bands: each visual text line is one row start, but a
    // cell that wraps over several visual lines must fold back into its record
    // in smart/none mode - exactly like the PDF draw-table path (00014). In
    // keep mode every visual line stays a separate GFM row. The first row is
    // the header.
    let visual_rows: Vec<(Vec<String>, f64, f64)> = group_blocks_into_lines(&blocks)
      .iter()
      .map(|line| {
        // cells of the visual line + representative vertical centre and font
        // size (max block height) for the fold gap check.
        let cells = cut_line_by_columns(line);
        let y = line.iter().map(|b| b.top + b.height / 2.0).sum::<f64>() / line.len() as f64;
        let font = line.iter().map(|b| b.height).fold(0.0_f64, f64::max);
        (cells, y, font)
      })
      .collect();
    if paragraph_mode == ParagraphMode::Guided {
      // 00015: fold only the user-selected columns. Empty merge_columns
      // degrades to per-line (one GFM row per visual line); the UI should
      // prompt when nothing is selected.
      let cols = guided.map(|g| g.merge_columns.as_slice()).unwrap_or(&[]);
      guided_merge_rows(visual_rows, cols)
    } else {
      fold_continuation_rows(visual_rows)
    }
  } else {
    // Grid mode: the drawn horizontal lines define row bands. Every band
    // emits exactly one row (empty bands become blank cells); inside a band,
    // several stacked text lines merge cell-wise with spaces so the GFM row
    // structure stays intact.
    let mut bounds: Vec<f64> = vec![0.0];
    bounds.extend(horizontal_px.iter().copied());
    bounds.push(img_height);
    bounds.retain(|v| *v >= 0.0 && *v <= img_height);
    bounds.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    bounds.dedup();
    if bounds.len() < 2 {
      return String::new();
    }

    let mut rows = Vec::with_capacity(bounds.len() - 1);
    for pair in bounds.windows(2) {
      let (band_top, band_bottom) = (pair[0], pair[1]);
      let in_band: Vec<&crate::core::ocr::OcrBlock> = blocks
        .iter()
        .copied()
        .filter(|b| {
          let center = b.top + b.height / 2.0;
          center >= band_top && center < band_bottom
        })
        .collect();
      if in_band.is_empty() {
        rows.push(vec![String::new(); ncols]);
        continue;
      }
      let text_lines = group_blocks_into_lines(&in_band);
      let ncols_total = ncols;
      let mut merged = vec![Vec::<String>::new(); ncols_total];
      for line in &text_lines {
        for (col, cell) in cut_line_by_columns(line).into_iter().enumerate() {
          if !cell.is_empty() {
            merged[col].push(cell);
          }
        }
      }
      rows.push(
        merged
          .into_iter()
          .map(|parts| {
            paragraph::join_fragments(&parts.iter().map(String::as_str).collect::<Vec<_>>())
          })
          .collect(),
      );
    }
    rows
  };

  if data_rows.is_empty() {
    return String::new();
  }

  // First row = header, rest = data rows.
  let header = &data_rows[0];
  let rows = if data_rows.len() > 1 {
    &data_rows[1..]
  } else {
    &[][..]
  };

  let mut out = format!(
    "| {} |\n|{}|\n",
    header
      .iter()
      .map(|c| c.as_str())
      .collect::<Vec<_>>()
      .join(" | "),
    header.iter().map(|_| " --- ").collect::<Vec<_>>().join("|"),
  );
  for row in rows {
    out.push_str(&format!(
      "| {} |\n",
      row
        .iter()
        .map(|c| c.as_str())
        .collect::<Vec<_>>()
        .join(" | ")
    ));
  }
  out
}

/// A vertical gap at least this wide (in units of the record's line height)
/// separates two records rather than marking a wrapped continuation line.
const ROW_GAP_EM: f64 = 2.5;

/// Index of the first cell holding visible text, if any.
fn first_content_col(cells: &[String]) -> Option<usize> {
  cells.iter().position(|c| !c.trim().is_empty())
}

/// Fold wrapped cell continuations back into their record when only vertical
/// separators are drawn (no horizontal row bands).
///
/// ```text
/// | idx | desc |        | idx | desc      |
/// | 1   | this |   →    | 1   | this is…  |
/// |     | is   |        |     | …test     |
/// |     | test |
/// ```
///
/// A wrapped remainder is recognised by where it starts: it leaves the columns
/// to its left empty and its first non-empty column sits right of the record's
/// first one, with content directly above in that column and no block gap. The
/// rule stays narrow so a record that genuinely has an empty leading column
/// keeps its own row. The caller only reaches this pass for `Smart` / `None`
/// (mirrors the PDF draw-table `merge_continuation_rows`); `Guided` uses
/// `guided_merge_rows` instead.
fn fold_continuation_rows(rows: Vec<(Vec<String>, f64, f64)>) -> Vec<Vec<String>> {
  if rows.is_empty() {
    return rows.into_iter().map(|(cells, _, _)| cells).collect();
  }
  // (cells, y of last line, leading font, first_content_col, continues)
  let mut out: Vec<(Vec<String>, f64, f64, Option<usize>, bool)> = Vec::with_capacity(rows.len());
  for (cells, y, font) in rows {
    let Some(col) = first_content_col(&cells) else {
      continue;
    };
    let is_continuation = match out.last() {
      // A gap this wide separates two records - block break, not a wrap.
      Some((_, prev_y, prev_font, _, _)) if y - *prev_y > *prev_font * ROW_GAP_EM => false,
      Some((prev_cells, _, _, prev_first, prev_continues)) => match prev_first {
        // Starts further right than the record above: the wrapped remainder of
        // a cell, provided that column holds visible text directly above.
        Some(p) if p < &col => {
          col > 0
            && cells[..col].iter().all(|c| c.trim().is_empty())
            && prev_cells.get(col).is_some_and(|c| !c.trim().is_empty())
        }
        // Same column as a known continuation: another line of that wrap.
        Some(p) if p == &col => col > 0 && *prev_continues,
        _ => false,
      },
      None => false,
    };
    if is_continuation {
      // `is_continuation` is only true when `out.last()` matched a `Some`,
      // so a record always exists here.
      if let Some(prev) = out.last_mut() {
        for (i, cell) in cells.iter().enumerate() {
          if cell.trim().is_empty() {
            continue;
          }
          if let Some(slot) = prev.0.get_mut(i) {
            *slot = paragraph::join_fragments(&[slot.as_str(), cell.as_str()]);
          }
        }
        prev.1 = y;
        prev.3 = Some(col);
        prev.4 = true;
      }
    } else {
      out.push((cells, y, font, Some(col), false));
    }
  }
  out.into_iter().map(|(cells, _, _, _, _)| cells).collect()
}

/// Guided (00015) column merge: split the visual lines into records on
/// `ROW_GAP_EM` block breaks, then fold each *user-selected* column's wrapped
/// lines back into its record cell via `join_fragments`. Columns not listed in
/// `merge_columns` keep the first line's cell (per-record, line-by-line).
///
/// ```text
/// | Account | ... | description           |
/// |         | ... | New balance           |   ← record 1
/// | 1969... | ... | Purchase on stock     |   ← record 2
/// |         | ... | MANULIFE              |   ← folds into record 2 desc
/// ```
fn guided_merge_rows(
  rows: Vec<(Vec<String>, f64, f64)>,
  merge_columns: &[usize],
) -> Vec<Vec<String>> {
  // Empty merge_columns == `keep`: every visual line stays its own row
  // (00015 §2.3 / §6.1). Nothing is merged, so skip the whole pass.
  if merge_columns.is_empty() {
    return rows.into_iter().map(|(cells, _, _)| cells).collect();
  }
  // Separate consecutive lines into records. A line starts a **new record**
  // when it is the first line (the header), when it follows the header (the
  // header never accepts a fold - otherwise a first data row with an empty
  // leading column would be glued onto the header), when its first non-empty
  // column is column 0 (a flush-left top-level row), or when the gap from the
  // previous line exceeds `ROW_GAP_EM`. Otherwise it is a wrapped continuation.
  let mut records: Vec<Vec<(Vec<String>, f64, f64)>> = Vec::new();
  for (cells, y, font) in rows {
    let col = first_content_col(&cells);
    let starts_new = records.len() <= 1
      || col == Some(0)
      || records
        .last()
        .and_then(|r| r.last())
        .map_or(true, |(_, prev_y, prev_font)| {
          y - *prev_y > *prev_font * ROW_GAP_EM
        });
    if starts_new {
      records.push(vec![(cells, y, font)]);
    } else {
      records
        .last_mut()
        .expect("records non-empty when pushing")
        .push((cells, y, font));
    }
  }

  records
    .into_iter()
    .map(|rec| {
      let ncols = rec.first().map(|(cells, _, _)| cells.len()).unwrap_or(0);
      let mut out: Vec<String> = Vec::with_capacity(ncols);
      for col in 0..ncols {
        // Merge columns: join every non-empty line across the record. Other
        // columns: keep the first line's cell only.
        let mut acc: Option<String> = None;
        if merge_columns.contains(&col) {
          let parts: Vec<&str> = rec
            .iter()
            .flat_map(|(cells, _, _)| {
              cells
                .get(col)
                .filter(|c| !c.trim().is_empty())
                .map(|c| c.trim())
            })
            .collect();
          if !parts.is_empty() {
            acc = Some(paragraph::join_fragments(&parts));
          }
        } else {
          let first = rec.iter().find_map(|(cells, _, _)| {
            cells
              .get(col)
              .filter(|c| !c.trim().is_empty())
              .map(|c| c.trim())
          });
          acc = first.map(|s| s.to_string());
        }
        out.push(acc.unwrap_or_default());
      }
      out
    })
    .collect()
}

/// Group OCR blocks into visual text lines using the same conservative
/// y-overlap threshold as the rest of the pipeline.
fn group_blocks_into_lines<'a>(
  blocks: &[&'a crate::core::ocr::OcrBlock],
) -> Vec<Vec<&'a crate::core::ocr::OcrBlock>> {
  let mut lines: Vec<Vec<&crate::core::ocr::OcrBlock>> = Vec::new();
  if blocks.is_empty() {
    return lines;
  }
  let mut cur_line = vec![blocks[0]];
  let mut cur_y = blocks[0].top;
  for block in &blocks[1..] {
    let threshold = (block.height * 0.4).max(3.0);
    if (block.top - cur_y).abs() < threshold {
      cur_line.push(block);
    } else {
      cur_line.sort_by(|a, b| {
        a.left
          .partial_cmp(&b.left)
          .unwrap_or(std::cmp::Ordering::Equal)
      });
      lines.push(cur_line);
      cur_line = vec![*block];
      cur_y = block.top;
    }
  }
  if !cur_line.is_empty() {
    cur_line.sort_by(|a, b| {
      a.left
        .partial_cmp(&b.left)
        .unwrap_or(std::cmp::Ordering::Equal)
    });
    lines.push(cur_line);
  }
  lines
}

#[cfg(test)]
mod tests {
  use super::*;

  fn region(x: i32, y: i32, w: u32, h: u32) -> ShotRegion {
    ShotRegion {
      monitor_id: 1,
      x,
      y,
      width: w,
      height: h,
    }
  }

  fn block(text: &str, left: f64, top: f64, width: f64, height: f64) -> crate::core::ocr::OcrBlock {
    crate::core::ocr::OcrBlock {
      text: text.to_string(),
      left,
      top,
      width,
      height,
    }
  }

  #[test]
  fn ocr_blocks_without_horizontal_lines_auto_group_rows() {
    let recognition = crate::core::ocr::OcrRecognition {
      blocks: vec![
        block("姓名", 10.0, 10.0, 20.0, 10.0),
        block("年龄", 60.0, 10.0, 20.0, 10.0),
        block("张三", 10.0, 50.0, 20.0, 10.0),
        block("28", 60.0, 50.0, 20.0, 10.0),
      ],
      height_px: 100,
      confidence: 0.9,
    };
    let md = extract_table_from_ocr_blocks(
      &recognition,
      &[50.0],
      &[],
      100.0,
      100.0,
      " ",
      ParagraphMode::Smart,
      None,
    );
    assert!(md.contains("| 姓名 | 年龄 |"));
    assert!(md.contains("| 张三 | 28 |"));
  }

  #[test]
  fn ocr_blocks_vertical_only_folds_wrapped_cell_in_smart_mode() {
    let recognition = crate::core::ocr::OcrRecognition {
      blocks: vec![
        // Header line.
        block("序号", 10.0, 10.0, 20.0, 10.0),
        block("说明", 70.0, 10.0, 30.0, 10.0),
        // Record line + two wrapped continuations of the last column.
        block("1", 10.0, 40.0, 10.0, 10.0),
        block("This is a", 70.0, 40.0, 40.0, 10.0),
        block("wrapped", 80.0, 55.0, 40.0, 10.0),
        block("cell", 80.0, 70.0, 30.0, 10.0),
      ],
      height_px: 150,
      confidence: 0.9,
    };
    let md = extract_table_from_ocr_blocks(
      &recognition,
      &[50.0],
      &[],
      150.0,
      150.0,
      " ",
      ParagraphMode::Smart,
      None,
    );
    let lines: Vec<&str> = md.lines().filter(|l| l.starts_with('|')).collect();
    // Header + delimiter + one folded data row (no per-line rows).
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0], "| 序号 | 说明 |");
    assert!(lines[1].starts_with("| -"));
    assert_eq!(lines[2], "| 1 | This is a wrapped cell |");
  }

  #[test]
  fn ocr_blocks_grid_mode_cuts_rows_at_horizontal_lines() {
    let recognition = crate::core::ocr::OcrRecognition {
      blocks: vec![
        block("姓名", 10.0, 10.0, 20.0, 10.0),
        block("年龄", 60.0, 10.0, 20.0, 10.0),
        // Two stacked blocks inside one band merge into one cell.
        block("张三", 10.0, 50.0, 20.0, 10.0),
        block("张三 2", 10.0, 62.0, 20.0, 10.0),
        block("28", 60.0, 55.0, 20.0, 10.0),
      ],
      height_px: 100,
      confidence: 0.85,
    };
    let md = extract_table_from_ocr_blocks(
      &recognition,
      &[50.0],
      &[30.0],
      100.0,
      100.0,
      " ",
      ParagraphMode::Smart,
      None,
    );
    // Topmost band is the header; the lower band merges stacked blocks.
    let mut lines = md.lines().filter(|l| l.starts_with('|'));
    assert_eq!(lines.next().unwrap(), "| 姓名 | 年龄 |");
    assert!(lines.next().unwrap().starts_with("| -")); // GFM delimiter row
    // `join_fragments` joins the stacked CJK fragments without an extra space.
    assert_eq!(lines.next().unwrap(), "| 张三张三 2 | 28 |");
  }

  #[test]
  fn clamp_region_keeps_valid_selection() {
    assert_eq!(
      clamp_region(&region(10, 20, 300, 200), 1920, 1080),
      Some((10, 20, 300, 200))
    );
  }

  #[test]
  fn clamp_region_clamps_out_of_bounds() {
    // Overflows the right/bottom edge.
    assert_eq!(
      clamp_region(&region(1900, 1000, 500, 500), 1920, 1080),
      Some((1900, 1000, 20, 80))
    );
    // Starts fully outside - nothing of the selection intersects the frame.
    assert_eq!(clamp_region(&region(-50, -50, 40, 40), 1920, 1080), None);
  }

  #[test]
  fn clamp_region_rejects_degenerate_selection() {
    // Accidental click without dragging.
    assert_eq!(clamp_region(&region(100, 100, 2, 2), 1920, 1080), None);
    assert_eq!(clamp_region(&region(0, 0, 0, 0), 1920, 1080), None);
    // Fully outside the frame.
    assert_eq!(clamp_region(&region(5000, 5000, 10, 10), 1920, 1080), None);
  }

  // ── §7.1 (00014): screenshot OCR has no geometry, so it reuses the same
  //    `paragraph::apply_text` textual policy as the PDF OCR channels. These
  //    are pure-function tests - no OCR engine or image mock is involved.

  #[test]
  fn screenshot_policy_merges_latin_soft_breaks() {
    use crate::models::ParagraphMode;
    let src = "This document specifies\nthe interface.";
    assert_eq!(
      crate::core::paragraph::apply_text(src, ParagraphMode::Smart),
      "This document specifies the interface."
    );
  }

  #[test]
  fn screenshot_policy_merges_cjk_soft_breaks() {
    use crate::models::ParagraphMode;
    let src = "本文档规定了接口规范\n接入方应当完成鉴权\n未按要求调用自行承担";
    assert_eq!(
      crate::core::paragraph::apply_text(src, ParagraphMode::Smart),
      "本文档规定了接口规范接入方应当完成鉴权未按要求调用自行承担"
    );
  }

  #[test]
  fn screenshot_policy_keeps_list_items() {
    use crate::models::ParagraphMode;
    let src = "- 项目一\n- 项目二";
    assert_eq!(
      crate::core::paragraph::apply_text(src, ParagraphMode::Smart),
      src
    );
  }

  #[test]
  fn screenshot_policy_guided_is_identity() {
    use crate::models::ParagraphMode;
    // Outside the image-table extractor `guided` has no column context, so it
    // keeps the text unchanged - identical to the removed `keep` mode.
    let src = "本文档规定了XX。\n接入方应当鉴权。\n未按要求调用。";
    assert_eq!(
      crate::core::paragraph::apply_text(src, ParagraphMode::Guided),
      src
    );
  }

  #[test]
  fn screenshot_policy_sentence_end_starts_new_paragraph() {
    use crate::models::ParagraphMode;
    // 00013 §4.3 T1 keeps a hard break after sentence-ending punctuation in
    // the no-geometry textual path. So in `smart`, OCR-derived text whose every
    // visual line ends in '。' is preserved line-by-line - identical to the
    // PDF OCR channels. (This differs from 00014 §7.1's illustrative example,
    // which assumed those lines would merge.)
    let src = "本文档规定了XX。\n接入方应当鉴权。\n未按要求调用。";
    assert_eq!(
      crate::core::paragraph::apply_text(src, ParagraphMode::Smart),
      src
    );
  }

  // ── 00015 Guided mode: merge only the user-picked columns ──────────────
  // Acceptance sample from the doc: only `description` (col 3) wraps; the
  // `value date` / `acc date` columns must stay line-by-line, and separate
  // records (New balance vs Purchase on stock) must not be fused.

  fn guided_config(merge_columns: Vec<usize>) -> GuidedMergeConfig {
    GuidedMergeConfig {
      vertical_lines: vec![],
      horizontal_lines: vec![],
      merge_columns,
    }
  }

  #[test]
  fn guided_merges_only_selected_column_across_records() {
    // 4 columns: Account | value date | acc date | description. vertical
    // separators at x = 25 / 50 / 75 (% width). font height 10 → ROW_GAP_EM
    // break at 25px, so records ~30px apart split, a wrapped continuation
    // ~15px below merges into its record.
    let recognition = crate::core::ocr::OcrRecognition {
      blocks: vec![
        // header
        block("Account", 2.0, 10.0, 20.0, 10.0),
        block("value date", 28.0, 10.0, 20.0, 10.0),
        block("acc date", 53.0, 10.0, 20.0, 10.0),
        block("description", 78.0, 10.0, 20.0, 10.0),
        // record 1
        block("31/03/2025", 28.0, 40.0, 20.0, 10.0),
        block("31/03/2025", 53.0, 40.0, 20.0, 10.0),
        block("New balance", 78.0, 40.0, 20.0, 10.0),
        // record 2 (account filled)
        block("1969BO1027", 2.0, 70.0, 20.0, 10.0),
        block("31/07/2024", 28.0, 70.0, 20.0, 10.0),
        block("01/08/2024", 53.0, 70.0, 20.0, 10.0),
        block("Purchase on stock", 78.0, 70.0, 20.0, 10.0),
        // wrapped continuation of record 2's description
        block("MANULIFE", 78.0, 85.0, 20.0, 10.0),
      ],
      height_px: 100,
      confidence: 0.9,
    };
    let md = extract_table_from_ocr_blocks(
      &recognition,
      &[25.0, 50.0, 75.0],
      &[],
      100.0,
      100.0,
      " ",
      ParagraphMode::Guided,
      Some(&guided_config(vec![3])),
    );
    let lines: Vec<&str> = md.lines().filter(|l| l.starts_with('|')).collect();
    assert_eq!(lines.len(), 4); // header + delimiter + 2 data rows
    assert_eq!(
      lines[0],
      "| Account | value date | acc date | description |"
    );
    assert!(lines[1].starts_with("| -"));
    // record 1: non-merge columns keep their single cell; desc is its own cell.
    assert_eq!(lines[2], "|  | 31/03/2025 | 31/03/2025 | New balance |");
    // record 2: description folded the wrapped "MANULIFE" into one cell.
    assert_eq!(
      lines[3],
      "| 1969BO1027 | 31/07/2024 | 01/08/2024 | Purchase on stock MANULIFE |"
    );
  }

  #[test]
  fn guided_respects_record_boundary_within_merge_column() {
    // Two records sharing the same description column must NOT fuse. Gaps are
    // ~30px (> 2.5×10=25 break); no wrapped continuation present.
    let recognition = crate::core::ocr::OcrRecognition {
      blocks: vec![
        block("Account", 2.0, 10.0, 20.0, 10.0),
        block("value date", 28.0, 10.0, 20.0, 10.0),
        block("acc date", 53.0, 10.0, 20.0, 10.0),
        block("description", 78.0, 10.0, 20.0, 10.0),
        block("31/03/2025", 28.0, 40.0, 20.0, 10.0),
        block("31/03/2025", 53.0, 40.0, 20.0, 10.0),
        block("New balance", 78.0, 40.0, 20.0, 10.0),
        block("1969BO1027", 2.0, 70.0, 20.0, 10.0),
        block("31/07/2024", 28.0, 70.0, 20.0, 10.0),
        block("01/08/2024", 53.0, 70.0, 20.0, 10.0),
        block("Purchase on stock", 78.0, 70.0, 20.0, 10.0),
      ],
      height_px: 100,
      confidence: 0.9,
    };
    let md = extract_table_from_ocr_blocks(
      &recognition,
      &[25.0, 50.0, 75.0],
      &[],
      100.0,
      100.0,
      " ",
      ParagraphMode::Guided,
      Some(&guided_config(vec![3])),
    );
    let lines: Vec<&str> = md.lines().filter(|l| l.starts_with('|')).collect();
    assert_eq!(lines.len(), 4);
    // "New balance" and "Purchase on stock" are separate description cells.
    assert_eq!(lines[2], "|  | 31/03/2025 | 31/03/2025 | New balance |");
    assert_eq!(
      lines[3],
      "| 1969BO1027 | 31/07/2024 | 01/08/2024 | Purchase on stock |"
    );
  }

  #[test]
  fn guided_empty_merge_columns_degrades_to_keep() {
    // No merge column selected → every line stays its own row (nothing folds).
    let recognition = crate::core::ocr::OcrRecognition {
      blocks: vec![
        block("序号", 10.0, 10.0, 20.0, 10.0),
        block("说明", 70.0, 10.0, 30.0, 10.0),
        block("1", 10.0, 40.0, 10.0, 10.0),
        block("This is a", 70.0, 40.0, 40.0, 10.0),
        block("wrapped", 80.0, 55.0, 40.0, 10.0),
        block("cell", 80.0, 70.0, 30.0, 10.0),
      ],
      height_px: 150,
      confidence: 0.9,
    };
    let md = extract_table_from_ocr_blocks(
      &recognition,
      &[50.0],
      &[],
      150.0,
      150.0,
      " ",
      ParagraphMode::Guided,
      Some(&guided_config(vec![])),
    );
    let lines: Vec<&str> = md.lines().filter(|l| l.starts_with('|')).collect();
    // Header + delimiter + one row per visual line (nothing folded).
    assert_eq!(lines.len(), 5);
    assert!(lines[3].contains("|  | wrapped |"));
    assert!(lines[4].contains("|  | cell |"));
  }
}
