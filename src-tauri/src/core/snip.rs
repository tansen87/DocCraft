use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use image::{RgbaImage, imageops::crop_imm};
use png::{BitDepth, ColorType, Compression, Encoder};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use xcap::Monitor;

use crate::core::settings;
use crate::models::{
  ImageTableRequest, ImageTableResult, MonitorSnapshot, OcrImageResult, ShotRegion, WindowInfo,
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

/// Encode raw RGBA data as a PNG with zero (or near-zero) compression.
/// This is the same technique used by `screenshots::Image::to_png(Fast)`.
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

/// Encode an RGBA frame as PNG bytes (fallback, used for OCR crop).
fn encode_png(frame: &RgbaImage) -> Result<Vec<u8>, String> {
  let mut buf = Cursor::new(Vec::new());
  frame
    .write_to(&mut buf, image::ImageFormat::Png)
    .map_err(|e| format!("Failed to encode PNG: {e}"))?;
  Ok(buf.into_inner())
}

fn base64_encode(data: &[u8]) -> String {
  base64::Engine::encode(&base64::engine::general_purpose::STANDARD, data)
}

/// Normalize a raw selection against the monitor frame. Returns the clamped
/// `(x, y, width, height)` in physical pixels, or `None` when the selection is
/// empty / degenerate (< 4 px on a side — treated as an accidental click).
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
  let png = encode_fast_png(frame.as_raw(), width, height)?;
  let data_url = format!("data:image/png;base64,{}", base64_encode(&png));

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

/// Crop the selected region out of the cached snapshot, persist it as a PNG
/// under the app data directory and run the configured OCR engine over it.
///
/// Consumes the snapshot for the given monitor; any other cached monitors are
/// dropped afterwards by [`end_screenshot_session`] (invoked by the command
/// layer regardless of success).
pub async fn screenshot_ocr(app: &AppHandle, region: ShotRegion) -> Result<OcrImageResult, String> {
  let mode = settings::get_app_settings(app)?.ocr_mode;
  if !mode.is_enabled() {
    return Err("OCR is disabled in settings".to_string());
  }

  let frame = {
    let store = app.state::<SnipStore>();
    let mut map = store.lock();
    map
      .remove(&region.monitor_id)
      .ok_or_else(|| "Screenshot session expired — please capture again".to_string())?
  };

  let start = Instant::now();
  let dir = screenshots_dir(app)?;

  // Crop + encode + persist off the async runtime, mirroring how file-based
  // conversion keeps blocking work away from futures.
  let (cropped_b64, saved_path) =
    tauri::async_runtime::spawn_blocking(move || -> Result<(String, String), String> {
      let Some((x, y, w, h)) = clamp_region(&region, frame.width(), frame.height()) else {
        return Err("Selection area is too small".to_string());
      };
      let cropped = crop_imm(&frame, x, y, w, h).to_image();
      let png = encode_png(&cropped)?;
      let b64 = base64_encode(&png);

      let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
      let path = dir.join(format!("shot-{stamp}.png"));
      std::fs::write(&path, &png).map_err(|e| format!("Failed to save screenshot: {e}"))?;
      Ok((b64, path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("Screenshot task failed: {e}"))??;

  let markdown = if mode.is_local() {
    let app = app.clone();
    let saved_for_read = saved_path.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
      let engine = crate::core::ocr::create_local_ocr_engine(&app)?;
      // Re-read the persisted copy instead of keeping both copies alive.
      let png =
        std::fs::read(&saved_for_read).map_err(|e| format!("Failed to read screenshot: {e}"))?;
      let text = engine.recognize_bytes(&png)?;
      if text.trim().is_empty() {
        return Err("Local OCR returned no content".to_string());
      }
      Ok(text.trim().to_string())
    })
    .await
    .map_err(|e| format!("Local OCR task failed: {e}"))??
  } else {
    let provider = crate::core::ocr::resolve_remote_provider(app)?
      .ok_or_else(|| "No available OCR supplier configured".to_string())?;
    crate::core::ocr::ai_recognize_image(&provider, &cropped_b64).await?
  };

  Ok(OcrImageResult {
    markdown,
    engine: (if mode.is_local() { "local" } else { "ai" }).to_string(),
    duration_ms: start.elapsed().as_millis() as u64,
    png_base64: Some(cropped_b64),
    saved_path: Some(saved_path),
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

  let img = image::open(&request.image_path)
    .map_err(|e| format!("Failed to load image: {e}"))?;
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
      move || -> Result<String, String> {
        let image_data = std::fs::read(&path)
          .map_err(|e| format!("Failed to read image file: {e}"))?;
        let engine = crate::core::ocr::create_local_ocr_engine(&app)?;
        let recognition = engine.recognize_png_blocks(&image_data)?;
        Ok(extract_table_from_ocr_blocks(
          &recognition,
          &vertical_px,
          img_width,
          img_height,
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

    let png_bytes = std::fs::read(&request.image_path)
      .map_err(|e| format!("Failed to read image: {e}"))?;
    let png_b64 = base64_encode(&png_bytes);

    let markdown = ai_recognize_table(
      &provider,
      0,
      &png_b64,
      &request.vertical_lines,
      &[],
    )
    .await?;

    Ok(ImageTableResult {
      markdown,
      engine: "ai".to_string(),
      duration_ms: start.elapsed().as_millis() as u64,
    })
  }
}

/// Build a GFM table from OCR text blocks by grouping them into lines and
/// cutting columns at the given vertical pixel positions.  The first line
/// becomes the header.
fn extract_table_from_ocr_blocks(
  recognition: &crate::core::ocr::OcrRecognition,
  vertical_px: &[f64],
  img_width: f64,
  _img_height: f64,
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

  // Sort blocks by y (top → bottom), then x (left → right).
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

  // Group into text lines.
  let mut lines: Vec<Vec<&crate::core::ocr::OcrBlock>> = Vec::new();
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
  if lines.is_empty() {
    return String::new();
  }

  // Extract cells per line per column.
  let mut data_rows: Vec<Vec<String>> = Vec::new();
  for line in &lines {
    let mut row = Vec::with_capacity(ncols);
    for col in 0..ncols {
      let left = col_bounds[col];
      let right = col_bounds[col + 1];
      let cell: String = line
        .iter()
        .filter(|b| {
          let center = b.left + b.width / 2.0;
          center >= left - 1e-3 && center < right + 1e-3
        })
        .map(|b| b.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
      row.push(cell.trim().to_string());
    }
    data_rows.push(row);
  }

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
    // Starts fully outside — nothing of the selection intersects the frame.
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
}
