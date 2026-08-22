use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use image::{RgbaImage, imageops::crop_imm};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use xcap::Monitor;

use crate::core::settings;
use crate::models::{MonitorSnapshot, OcrImageResult, ShotRegion};

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

/// Encode an RGBA frame as PNG bytes.
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

/// Capture every monitor once and stash the raw frames for cropping later.
/// Returns per-monitor metadata plus a PNG data URL used as the frozen
/// background of each overlay window.
pub async fn begin_screenshot(app: &AppHandle) -> Result<Vec<MonitorSnapshot>, String> {
  // Hide the main window BEFORE freezing the desktop so the app never
  // appears in its own snapshot.
  if let Some(main) = app.get_webview_window("main") {
    let _ = main.hide();
  }

  let captures = tauri::async_runtime::spawn_blocking(|| -> Result<Vec<_>, String> {
    // Give the compositor a moment to actually remove the window from screen.
    std::thread::sleep(std::time::Duration::from_millis(200));
    let monitors = Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {e}"))?;
    if monitors.is_empty() {
      return Err("No monitor available for screen capture".to_string());
    }
    let mut out = Vec::with_capacity(monitors.len());
    for m in monitors {
      // xcap 0.4 wraps every getter in a Result — flatten them as we go.
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
      let png = encode_png(&frame)?;
      let data_url = format!("data:image/png;base64,{}", base64_encode(&png));
      out.push((
        MonitorSnapshot {
          id,
          x,
          y,
          width: frame.width(),
          height: frame.height(),
          scale_factor: scale as f64,
          data_url,
        },
        (id, frame),
      ));
    }
    Ok(out)
  })
  .await
  .map_err(|e| format!("Screenshot task failed: {e}"))??;

  let store = app.state::<SnipStore>();
  {
    let mut map = store.lock();
    map.clear();
    for (_, entry) in &captures {
      map.insert(entry.0, entry.1.clone());
    }
  }

  Ok(captures.into_iter().map(|(snap, _)| snap).collect())
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

/// Drop every cached snapshot and bring the main window back.
pub fn end_screenshot_session(app: &AppHandle) {
  app.state::<SnipStore>().lock().clear();
  if let Some(main) = app.get_webview_window("main") {
    let _ = main.show();
    let _ = main.set_focus();
  }
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
