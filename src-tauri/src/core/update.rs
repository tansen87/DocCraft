//! Release check + signed auto-update (docs/design/00021_auto-download-install.md).
//!
//! Two responsibilities, both driven from here so the frontend never touches
//! network or installer APIs:
//!
//! 1. **Report** - a release check runs once per session, ~3s after startup, on
//!    a background thread (`lib.rs`), and pushes [`UpdateSnapshot`]s over
//!    `update://state`. Available updates surface as a green dot.
//! 2. **Apply** - `update_now` downloads the installer announced by the GitHub
//!    release manifest and installs it. The package is verified against the
//!    minisign public key baked into `tauri.conf.json`; `Update::download`
//!    refuses to return bytes that fail verification.
//!
//! Everything is best-effort: check failures degrade to `snapshot.error`
//! (surfaced only for a manual action) and nothing is downloaded or executed
//! without an explicit user click.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::core::settings;

/// Release page opened by the dialog's manual-download fallback (GitHub only).
pub const RELEASE_PAGE_URL: &str = "https://github.com/tansen87/DocCraft/releases/latest";

/// Cap on the manifest / download requests (the plugin sets no default).
const HTTP_TIMEOUT_SECS: u64 = 10;

/// Event carrying the full [`UpdateSnapshot`].
const STATE_EVENT: &str = "update://state";

/// Minimum gap between download progress events, so a fast download cannot
/// flood the webview with IPC messages.
const PROGRESS_THROTTLE_MS: u64 = 250;

/// Update manifest consumed by the plugin - mirrors
/// `tauri.conf.json > plugins.updater.endpoints` (only used in error messages).
const ENDPOINT: &str =
  "https://github.com/tansen87/DocCraft/releases/latest/download/latest.json";

/// Machine-readable error kinds the frontend can localise. Anything unknown is
/// reported verbatim.
const KIND_NO_MANIFEST: &str = "noManifest";
const KIND_NETWORK: &str = "network";

/// Phases the UI switches on.
const PHASE_IDLE: &str = "idle";
const PHASE_CHECKING: &str = "checking";
const PHASE_AVAILABLE: &str = "available";
const PHASE_DOWNLOADING: &str = "downloading";
const PHASE_INSTALLING: &str = "installing";
const PHASE_SKIPPED: &str = "skipped";
const PHASE_ERROR: &str = "error";

/// Snapshot of the updater state, pushed to the frontend as a whole.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
  /// One of the `PHASE_*` values.
  pub phase: String,
  /// Version currently running.
  pub current_version: String,
  /// Version announced by the newest published release.
  pub version: Option<String>,
  /// Release publish date (`YYYY-MM-DD`), when the manifest reports one.
  pub date: Option<String>,
  /// Release notes markdown.
  pub notes: Option<String>,
  /// GitHub release page - the manual fallback entry point.
  pub release_url: String,
  /// Error text; only surfaced for an explicit (manual) action.
  pub error: Option<String>,
  /// Machine-readable error kind (`noManifest` / `network`) so the UI can show
  /// a localised, actionable message instead of the plugin's wording.
  pub error_kind: Option<String>,
  /// Bytes fetched so far (download phase only).
  pub downloaded_bytes: u64,
  /// Total size, when the server reports `Content-Length`.
  pub total_bytes: Option<u64>,
  /// Whether this installation can replace itself in place. False when the
  /// executable sits in a protected location (the UI then offers the manual
  /// download instead of a button that is bound to fail).
  pub auto_install: bool,
}

impl UpdateSnapshot {
  fn new(current_version: String, phase: &str, auto_install: bool) -> Self {
    Self {
      phase: phase.to_string(),
      current_version,
      version: None,
      date: None,
      notes: None,
      release_url: RELEASE_PAGE_URL.to_string(),
      error: None,
      error_kind: None,
      downloaded_bytes: 0,
      total_bytes: None,
      auto_install,
    }
  }
}

/// Managed state: last snapshot, the announced update and the busy flag.
pub struct UpdateState(Mutex<UpdateStateInner>);

#[derive(Default)]
struct UpdateStateInner {
  snapshot: Option<UpdateSnapshot>,
  /// The startup check already ran (or was disabled) this session.
  checked: bool,
  /// A check request is in flight (single-flight guard).
  in_flight: bool,
  /// A download/install is running.
  busy: bool,
  /// Last announced update, reused when the user clicks "update now".
  update: Option<Update>,
}

impl Default for UpdateState {
  fn default() -> Self {
    Self(Mutex::new(UpdateStateInner::default()))
  }
}

fn current_version(app: &AppHandle) -> String {
  app.package_info().version.to_string()
}

/// `path` is `prefix` itself or lives below it, compared case-insensitively on
/// whole path segments (mirrors the installer guard in `installer-hooks.nsh`;
/// `C:\Program FilesX` must not match `C:\Program Files`).
fn path_is_inside(path: &Path, prefix: &str) -> bool {
  if prefix.is_empty() {
    return false;
  }
  let path = path.to_string_lossy().replace('/', "\\").to_lowercase();
  let prefix = prefix.replace('/', "\\").to_lowercase();
  path == prefix
    || (path.starts_with(&prefix) && path.as_bytes().get(prefix.len()) == Some(&b'\\'))
}

/// Whether the running executable can be replaced in place: the directory must
/// be writable and outside the locations Windows reserves for elevation (the
/// installer is per-user and cannot request admin - docs/design/00020 §3.3.3).
fn install_dir_writable() -> bool {
  let dir = crate::core::install_dir();

  #[cfg(windows)]
  {
    for var in ["ProgramFiles", "ProgramFiles(x86)", "windir", "ProgramData"] {
      if let Some(prefix) = std::env::var_os(var) {
        if path_is_inside(&dir, &prefix.to_string_lossy()) {
          return false;
        }
      }
    }
  }

  // A write probe is the only check that also covers read-only mounts and
  // per-directory ACLs.
  let probe = dir.join(".doccraft-write-test");
  match std::fs::write(&probe, b"ok") {
    Ok(()) => {
      let _ = std::fs::remove_file(&probe);
      true
    }
    Err(_) => false,
  }
}

/// Snapshot stored in state, falling back to a fresh idle one.
pub fn snapshot(app: &AppHandle) -> UpdateSnapshot {
  let state = app.state::<UpdateState>();
  let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
  guard.snapshot.clone().unwrap_or_else(|| {
    UpdateSnapshot::new(current_version(app), PHASE_IDLE, install_dir_writable())
  })
}

fn store(app: &AppHandle, snapshot: UpdateSnapshot) -> UpdateSnapshot {
  {
    let state = app.state::<UpdateState>();
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    guard.snapshot = Some(snapshot.clone());
  }
  emit_state(app, &snapshot);
  snapshot
}

/// Push the snapshot to the main window. Skipped while the window is hidden
/// (the frontend re-reads `get_update_state` when it needs the current value).
fn emit_state(app: &AppHandle, snapshot: &UpdateSnapshot) {
  if let Some(window) = app.get_webview_window("main") {
    if window.is_visible().unwrap_or(true) {
      let _ = window.emit(STATE_EVENT, snapshot.clone());
    }
  }
}

/// Startup path: honour `autoCheckUpdate` and run the check once per session.
pub async fn startup_check(app: AppHandle) {
  let enabled = settings::get_app_settings(&app)
    .map(|s| s.auto_check_update)
    .unwrap_or(true);
  if !enabled {
    let state = app.state::<UpdateState>();
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    guard.checked = true;
    return;
  }
  let _ = check(&app, false).await;
}

/// Ask the configured endpoint (the GitHub release manifest `latest.json`) for
/// an update. The plugin compares versions and returns `None` when current.
async fn fetch_update(
  app: &AppHandle,
) -> Result<Option<Update>, tauri_plugin_updater::Error> {
  let updater = app
    .updater_builder()
    .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
    .build()?;
  updater.check().await
}

/// Translate an updater failure into a message plus an optional kind the UI
/// can localise (docs/design/00021 §3.4).
fn describe_error(error: &tauri_plugin_updater::Error) -> (String, Option<String>) {
  use tauri_plugin_updater::Error as UpdaterError;
  match error {
    // The endpoint answered, but with no usable manifest: nothing published
    // yet, or the newest release is a draft / prerelease - `releases/latest`
    // never serves those, so the URL 404s.
    UpdaterError::ReleaseNotFound => (
      format!(
        "No updater manifest was found at {ENDPOINT} - the newest published \
         release must ship a latest.json asset (drafts and prereleases are not \
         served by releases/latest)."
      ),
      Some(KIND_NO_MANIFEST.to_string()),
    ),
    UpdaterError::Network(_) | UpdaterError::Reqwest(_) | UpdaterError::Http(_) => (
      error.to_string(),
      Some(KIND_NETWORK.to_string()),
    ),
    other => (other.to_string(), None),
  }
}

/// Run a release check. `force` bypasses the once-per-session guard (manual
/// button); non-forced calls return the cached snapshot when the startup check
/// already ran. Never returns an error: failures land in `snapshot.error`.
pub async fn check(app: &AppHandle, force: bool) -> UpdateSnapshot {
  {
    let state = app.state::<UpdateState>();
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if guard.in_flight || guard.busy {
      drop(guard);
      return snapshot(app);
    }
    if !force && guard.checked {
      if let Some(cached) = guard.snapshot.clone() {
        drop(guard);
        return cached;
      }
      drop(guard);
      return UpdateSnapshot::new(current_version(app), PHASE_IDLE, install_dir_writable());
    }
    guard.in_flight = true;
    guard.checked = true;
  }

  let auto_install = install_dir_writable();
  store(
    app,
    UpdateSnapshot::new(current_version(app), PHASE_CHECKING, auto_install),
  );

  let result = fetch_update(app).await;

  {
    let state = app.state::<UpdateState>();
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    guard.in_flight = false;
    // A failed or empty check must not leave a stale update behind.
    match &result {
      Ok(Some(update)) => guard.update = Some(update.clone()),
      _ => guard.update = None,
    }
  }

  let current = current_version(app);
  let skipped = settings::get_app_settings(app)
    .map(|s| s.update_skipped_version)
    .unwrap_or_default();

  match result {
    Ok(Some(update)) => {
      let phase = if update.version == skipped {
        PHASE_SKIPPED
      } else {
        PHASE_AVAILABLE
      };
      store(
        app,
        UpdateSnapshot {
          phase: phase.to_string(),
          current_version: current,
          version: Some(update.version.clone()),
          date: update.date.map(|d| d.date().to_string()),
          notes: update.body.clone(),
          release_url: RELEASE_PAGE_URL.to_string(),
          error: None,
          error_kind: None,
          downloaded_bytes: 0,
          total_bytes: None,
          auto_install,
        },
      )
    }
    // No published release yet, or already up to date: nothing to report.
    Ok(None) => store(app, UpdateSnapshot::new(current, PHASE_IDLE, auto_install)),
    Err(e) => {
      let (message, kind) = describe_error(&e);
      let mut snapshot = UpdateSnapshot::new(current, PHASE_ERROR, auto_install);
      snapshot.error = Some(message);
      snapshot.error_kind = kind;
      store(app, snapshot)
    }
  }
}

/// Hand back the announced update, running a check first when the startup check
/// has not found one (or was skipped).
async fn resolve_update(app: &AppHandle) -> Result<Update, String> {
  {
    let state = app.state::<UpdateState>();
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(update) = guard.update.clone() {
      return Ok(update);
    }
  }
  let snapshot = check(app, true).await;
  if let Some(error) = snapshot.error {
    return Err(error);
  }
  let state = app.state::<UpdateState>();
  let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
  guard.update.clone().ok_or_else(|| {
    format!("No update available (running {})", snapshot.current_version)
  })
}

/// Download and install the announced update.
///
/// The package is verified against the bundled public key before anything is
/// executed. On Windows the app exits while the installer runs; the plugin
/// passes the NSIS restart flag, so the new version comes back up by itself.
pub async fn update_now(app: AppHandle) -> Result<UpdateSnapshot, String> {
  if !install_dir_writable() {
    return Err(
      "This installation cannot update itself: the executable sits in a protected folder. \
       Download the new version from the release page instead."
        .to_string(),
    );
  }

  {
    let state = app.state::<UpdateState>();
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if guard.busy {
      drop(guard);
      return Ok(snapshot(&app));
    }
    guard.busy = true;
  }
  // The guard must be released on every exit path, however we leave.
  let guard_app = app.clone();
  let _release = BusyGuard(move || {
    let state = guard_app.state::<UpdateState>();
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    guard.busy = false;
  });

  let update = match resolve_update(&app).await {
    Ok(update) => update,
    Err(e) => {
      let mut snap = snapshot(&app);
      snap.phase = PHASE_ERROR.to_string();
      snap.error = Some(e.clone());
      store(&app, snap);
      return Err(e);
    }
  };

  let mut downloading = snapshot(&app);
  downloading.phase = PHASE_DOWNLOADING.to_string();
  downloading.downloaded_bytes = 0;
  downloading.total_bytes = None;
  downloading.error = None;
  store(&app, downloading);

  let progress = Arc::new(Mutex::new((0u64, None::<u64>, Instant::now())));
  let progress_for_cb = Arc::clone(&progress);
  let progress_app = app.clone();
  let downloaded = update
    .download(
      move |chunk_len, total| {
        let mut state = progress_for_cb.lock().unwrap_or_else(|e| e.into_inner());
        state.0 += chunk_len as u64;
        state.1 = total;
        if state.2.elapsed() < Duration::from_millis(PROGRESS_THROTTLE_MS) {
          return;
        }
        state.2 = Instant::now();
        let (done, total) = (state.0, state.1);
        drop(state);
        let mut snap = snapshot(&progress_app);
        snap.phase = PHASE_DOWNLOADING.to_string();
        snap.downloaded_bytes = done;
        snap.total_bytes = total;
        store(&progress_app, snap);
      },
      || {},
    )
    .await;

  let bytes = match downloaded {
    Ok(bytes) => bytes,
    Err(e) => {
      let mut snap = snapshot(&app);
      snap.phase = PHASE_ERROR.to_string();
      snap.downloaded_bytes = 0;
      snap.total_bytes = None;
      snap.error = Some(e.to_string());
      store(&app, snap);
      return Err(e.to_string());
    }
  };

  let mut installing = snapshot(&app);
  installing.phase = PHASE_INSTALLING.to_string();
  installing.downloaded_bytes = bytes.len() as u64;
  installing.total_bytes = Some(bytes.len() as u64);
  store(&app, installing);

  // Windows: launches the installer and exits the process (the NSIS restart
  // flag brings the new version back). macOS/Linux would need
  // `tauri-plugin-process` + relaunch() - out of scope while targets = nsis.
  update.install(&bytes).map_err(|e| e.to_string())?;
  Ok(snapshot(&app))
}

/// Runs a closure when dropped, so early returns cannot leak the busy flag.
struct BusyGuard<F: FnMut()>(F);

impl<F: FnMut()> Drop for BusyGuard<F> {
  fn drop(&mut self) {
    (self.0)();
  }
}

/// Remember a version the user does not want to be reminded about.
pub fn skip_version(app: &AppHandle, version: String) -> Result<UpdateSnapshot, String> {
  let mut settings = settings::get_app_settings(app)?;
  settings.update_skipped_version = version.clone();
  settings::set_app_settings(app, settings)?;
  let mut snapshot = snapshot(app);
  // Only silence the badge when the skipped version is the one announced.
  if !version.is_empty() && snapshot.version.as_deref() == Some(version.as_str()) {
    snapshot.phase = PHASE_SKIPPED.to_string();
  }
  Ok(store(app, snapshot))
}

/// Clear the skipped version so the next check reports it again.
pub fn clear_skipped_version(app: &AppHandle) -> Result<UpdateSnapshot, String> {
  let mut settings = settings::get_app_settings(app)?;
  settings.update_skipped_version = String::new();
  settings::set_app_settings(app, settings)?;
  let mut snapshot = snapshot(app);
  if snapshot.version.is_some() {
    snapshot.phase = PHASE_AVAILABLE.to_string();
  }
  Ok(store(app, snapshot))
}

/// One-shot notice shown after a completed upgrade.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionNotice {
  /// Version recorded on the previous run.
  pub from: String,
  /// Version now running.
  pub to: String,
}

/// Pending [`VersionNotice`], if the running version differs from the one
/// recorded last session.
pub struct VersionNoticeState(Mutex<Option<VersionNotice>>);

impl Default for VersionNoticeState {
  fn default() -> Self {
    Self(Mutex::new(None))
  }
}

/// Called once from `setup()`: compare the recorded version with the running
/// one, keep a notice when they differ, then persist the running version.
///
/// Pull-based on purpose - an event emitted during `setup()` would race the
/// frontend's listener registration, so the UI asks for the notice instead.
pub fn record_run_version(app: &AppHandle) {
  let current = current_version(app);
  let mut settings = match settings::get_app_settings(app) {
    Ok(settings) => settings,
    Err(e) => {
      eprintln!("Failed to load settings for the version marker: {e}");
      return;
    }
  };
  let stored = std::mem::take(&mut settings.last_run_version);
  if stored == current {
    return;
  }
  if !stored.is_empty() {
    let state = app.state::<VersionNoticeState>();
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(VersionNotice {
      from: stored,
      to: current.clone(),
    });
  }
  settings.last_run_version = current;
  if let Err(e) = settings::set_app_settings(app, settings) {
    eprintln!("Failed to record the running version: {e}");
  }
}

/// Hand the pending "just updated" notice to the frontend (consumed once).
pub fn take_version_notice(app: &AppHandle) -> Option<VersionNotice> {
  let state = app.state::<VersionNoticeState>();
  let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
  guard.take()
}

#[cfg(test)]
mod tests {
  use super::path_is_inside;
  use std::path::Path;

  #[test]
  fn recognises_protected_install_locations() {
    // Whole-segment, case-insensitive comparison: `C:\Program FilesX` must not
    // match `C:\Program Files`.
    assert!(path_is_inside(
      Path::new(r"C:\Program Files\DocCraft"),
      r"C:\Program Files"
    ));
    assert!(path_is_inside(
      Path::new(r"c:\program files\DocCraft"),
      r"C:\Program Files"
    ));
    assert!(path_is_inside(
      Path::new(r"C:\Program Files"),
      r"C:\Program Files"
    ));
    assert!(!path_is_inside(
      Path::new(r"C:\Program FilesX\DocCraft"),
      r"C:\Program Files"
    ));
    assert!(!path_is_inside(
      Path::new(r"C:\Users\me\DocCraft"),
      r"C:\Program Files"
    ));
    // An unset environment variable (empty prefix) must never match.
    assert!(!path_is_inside(Path::new(r"C:\anything"), ""));
  }
}
