//! On-demand model files: download from ModelScope and import local copies
//! (docs/design/00022_model-download.md).
//!
//! Models are **not shipped** with the installer (docs/design/00020 §3.4.2), so
//! the app fetches them from ModelScope on request - or takes files the user
//! already has (drag & drop in Settings). Every file is pinned by size and
//! SHA-256 in the table below, so a download is only accepted when it matches
//! byte for byte; imported local files are verified the same way.
//!
//! Layout on disk (all relative to `<install dir>/models`, see
//! `core::models_dir`):
//!
//! ```text
//! PP-OCRv6_{tiny,small,medium}_{det,rec}.mnn
//! ppocr_keys_v6_{tiny,small,medium}.txt
//! layout/PP-DocLayoutV3/{PP-DocLayoutV3.mnn,layout-meta.json}
//! ```
//!
//! These names are the ones `core::ocr` and `core::layout` resolve at runtime.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::core::models_dir;

/// ModelScope repository hosting the OCR tiers. Rename it here (one place) if
/// the uploads live under a different name.
const MS_OCR_REPO: &str = "tansen87/PP-OCRv6_mnn";
/// ModelScope repository hosting the layout model pool (already published).
const MS_LAYOUT_REPO: &str = "tansen87/PP-DocLayoutV3_mnn";
/// ModelScope revision requested. `master` keeps URLs stable; integrity comes
/// from the size + SHA-256 pins below, so a re-upload cannot be smuggled in.
const MS_REVISION: &str = "master";

/// Event carrying download progress (`ModelProgress`).
const PROGRESS_EVENT: &str = "models://progress";

/// Minimum gap between progress events, mirroring the updater's throttling.
const PROGRESS_THROTTLE_MS: u64 = 250;

/// One file of a model group.
struct FileSpec {
  /// File name on disk (also the name a dragged-in file must carry).
  name: &'static str,
  /// Path relative to `<install dir>/models`.
  target: &'static str,
  /// Path inside the ModelScope repository.
  remote: &'static str,
  size: u64,
  sha256: &'static str,
}

/// A downloadable unit: the OCR tiers ship as det + rec + keys, the layout
/// model as its weights + metadata.
struct GroupSpec {
  id: &'static str,
  kind: &'static str,
  repo: &'static str,
  files: &'static [FileSpec],
}

macro_rules! file {
  ($name:literal, $target:literal, $remote:literal, $size:literal, $sha:literal) => {
    FileSpec {
      name: $name,
      target: $target,
      remote: $remote,
      size: $size,
      sha256: $sha,
    }
  };
}

/// SHA-256 / size pins are the ones produced by the ModelScope API (verified
/// against the local `src-tauri/resources/models` copies on 2026-09-28).
const GROUPS: &[GroupSpec] = &[
  GroupSpec {
    id: "ocr.tiny",
    kind: "ocr",
    repo: MS_OCR_REPO,
    files: &[
      file!(
        "PP-OCRv6_tiny_det.mnn",
        "PP-OCRv6_tiny_det.mnn",
        "PP-OCRv6_tiny_det.mnn",
        901_896,
        "7fab7b858f136bc93a760bdca66aaf25f0ff10accabb31e6ef853a897fb9cfec"
      ),
      file!(
        "PP-OCRv6_tiny_rec.mnn",
        "PP-OCRv6_tiny_rec.mnn",
        "PP-OCRv6_tiny_rec.mnn",
        2_251_616,
        "0a43c3c979a98b905f5e84913209998f510189419b5a5d4152bbb01ce8d17a93"
      ),
      file!(
        "ppocr_keys_v6_tiny.txt",
        "ppocr_keys_v6_tiny.txt",
        "ppocr_keys_v6_tiny.txt",
        27_156,
        "c5cbe34ef40c29c4df07ed012bf96569cb69a2d2a01a07027e9f13cb832bd9cd"
      ),
    ],
  },
  GroupSpec {
    id: "ocr.small",
    kind: "ocr",
    repo: MS_OCR_REPO,
    files: &[
      file!(
        "PP-OCRv6_small_det.mnn",
        "PP-OCRv6_small_det.mnn",
        "PP-OCRv6_small_det.mnn",
        4_965_224,
        "2c6277abbbddb4c77a790f4650cdd7f8ab33512db38fac372ed5471538070619"
      ),
      file!(
        "PP-OCRv6_small_rec.mnn",
        "PP-OCRv6_small_rec.mnn",
        "PP-OCRv6_small_rec.mnn",
        10_646_760,
        "ed59cc294fe2d564bd64f929b5356b70abd0977f99e7e60e3b08cfeef4ef72be"
      ),
      file!(
        "ppocr_keys_v6_small.txt",
        "ppocr_keys_v6_small.txt",
        "ppocr_keys_v6_small.txt",
        74_947,
        "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d"
      ),
    ],
  },
  GroupSpec {
    id: "ocr.medium",
    kind: "ocr",
    repo: MS_OCR_REPO,
    files: &[
      file!(
        "PP-OCRv6_medium_det.mnn",
        "PP-OCRv6_medium_det.mnn",
        "PP-OCRv6_medium_det.mnn",
        31_078_716,
        "a174009ef81dd84f29034047cd56e50b73ef624a3a409226418be63ffc46ca60"
      ),
      file!(
        "PP-OCRv6_medium_rec.mnn",
        "PP-OCRv6_medium_rec.mnn",
        "PP-OCRv6_medium_rec.mnn",
        38_382_108,
        "11bbedb5af3a33cb7fee505de19223243d85b82c7b507af51e345ea1b4e68e72"
      ),
      // The medium tier reuses the small dictionary file (identical content).
      file!(
        "ppocr_keys_v6_medium.txt",
        "ppocr_keys_v6_medium.txt",
        "ppocr_keys_v6_medium.txt",
        74_947,
        "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d"
      ),
    ],
  },
  GroupSpec {
    id: "layout.PP-DocLayoutV3",
    kind: "layout",
    repo: MS_LAYOUT_REPO,
    files: &[
      file!(
        "PP-DocLayoutV3.mnn",
        "layout/PP-DocLayoutV3/PP-DocLayoutV3.mnn",
        "PP-DocLayoutV3.mnn",
        130_568_724,
        "872c751527a43180e81922e72b444e9ea516545877fb9eae24433abd9e355366"
      ),
      file!(
        "layout-meta.json",
        "layout/PP-DocLayoutV3/layout-meta.json",
        "layout-meta.json",
        1_444,
        "da1a4deb575e37038afbf855f6e69649d930c3e8bf0984100a4cf56d14c17a28"
      ),
    ],
  },
];

/// HTTP client for model downloads.
///
/// **The `User-Agent` header is mandatory, not cosmetic**: ModelScope's CDN
/// answers `403 Forbidden` to requests without one (reproduced 2026-09-28 -
/// the same URL returns `206` with any UA). `reqwest` sends no default agent,
/// so it has to be set explicitly here, exactly like the updater does for
/// GitHub.
fn http_client() -> Result<reqwest::Client, String> {
  reqwest::Client::builder()
    // Large files (the layout model is 125MB) need a generous cap; the
    // connection itself is still protected by reqwest's own timeouts.
    .timeout(Duration::from_secs(30 * 60))
    .user_agent(concat!("DocCraft/", env!("CARGO_PKG_VERSION")))
    .build()
    .map_err(|e| e.to_string())
}

/// Download URL of one file (single form for both plain and LFS blobs - the
/// `repo` endpoint serves `206 Partial Content`, so no special casing).
fn download_url(repo: &str, remote: &str) -> String {
  format!(
    "https://www.modelscope.cn/api/v1/models/{repo}/repo?Revision={MS_REVISION}&FilePath={remote}"
  )
}

// ─── DTOs ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFileDto {
  pub name: String,
  pub target: String,
  pub size: u64,
  pub installed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelGroupDto {
  pub id: String,
  /// `ocr` | `layout`.
  pub kind: String,
  pub files: Vec<ModelFileDto>,
  pub total_bytes: u64,
  /// Every file of the group is present with the expected size.
  pub installed: bool,
}

/// Progress of the running download (one file at a time).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProgress {
  pub group: String,
  pub file: String,
  pub downloaded: u64,
  pub total: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsSnapshot {
  /// Absolute directory the files live in (`<install dir>/models`), shown in
  /// Settings so a manual drop target is always obvious.
  pub root: String,
  pub groups: Vec<ModelGroupDto>,
  /// Currently running download, if any.
  pub active: Option<ModelProgress>,
}

/// Result of importing files the user provided.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalImportResult {
  /// Targets that were written (relative to `<install dir>/models`).
  pub imported: Vec<String>,
  /// Files that do not match any known model file name.
  pub ignored: Vec<String>,
  /// Files that matched but were rejected (`name: reason`).
  pub failed: Vec<String>,
}

/// Managed state: the active download, used as a single-flight guard.
#[derive(Default)]
pub struct ModelsState(Mutex<Option<ModelProgress>>);

// ─── Status ──────────────────────────────────────────────────────────────

fn installed(target: &str, size: u64) -> bool {
  let path = models_dir().join(target);
  std::fs::metadata(&path)
    .map(|meta| meta.is_file() && meta.len() == size)
    .unwrap_or(false)
}

fn group_dto(spec: &GroupSpec) -> ModelGroupDto {
  let files: Vec<ModelFileDto> = spec
    .files
    .iter()
    .map(|file| ModelFileDto {
      name: file.name.to_string(),
      target: file.target.to_string(),
      size: file.size,
      installed: installed(file.target, file.size),
    })
    .collect();
  ModelGroupDto {
    id: spec.id.to_string(),
    kind: spec.kind.to_string(),
    total_bytes: spec.files.iter().map(|f| f.size).sum(),
    installed: files.iter().all(|f| f.installed),
    files,
  }
}

/// Current state of every model group plus the running download, if any.
pub fn snapshot(app: &AppHandle) -> ModelsSnapshot {
  let active = {
    let state = app.state::<ModelsState>();
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    guard.clone()
  };
  ModelsSnapshot {
    root: models_dir().display().to_string(),
    groups: GROUPS.iter().map(group_dto).collect(),
    active,
  }
}

fn set_active(app: &AppHandle, active: Option<ModelProgress>) {
  let state = app.state::<ModelsState>();
  let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
  *guard = active;
}

// ─── Download ────────────────────────────────────────────────────────────

/// Download every file of one group into `<install dir>/models`.
///
/// Each file is streamed to a `.part` file while being hashed, then verified
/// (size + SHA-256) and only then renamed into place - a rejected download
/// never leaves a half-written model behind.
pub async fn download_group(app: AppHandle, group: String) -> Result<ModelsSnapshot, String> {
  let spec = GROUPS
    .iter()
    .find(|g| g.id == group)
    .ok_or_else(|| format!("Unknown model group: {group}"))?;

  {
    let state = app.state::<ModelsState>();
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_some() {
      return Err("Another model download is already running".to_string());
    }
    *guard = Some(ModelProgress {
      group: group.clone(),
      file: String::new(),
      downloaded: 0,
      total: spec.files.iter().map(|f| f.size).sum(),
    });
  }

  let result = run_download(&app, spec).await;
  set_active(&app, None);
  result?;
  Ok(snapshot(&app))
}

async fn run_download(app: &AppHandle, spec: &GroupSpec) -> Result<(), String> {
  let root = models_dir();
  let staging = root.join(".download");
  std::fs::create_dir_all(&staging)
    .map_err(|e| format!("Failed to create {}: {e}", staging.display()))?;

  let client = http_client()?;

  for file in spec.files {
    if installed(file.target, file.size) {
      continue;
    }
    let url = download_url(spec.repo, file.remote);
    let part = staging.join(format!("{}.part", file.name));

    let mut response = client
      .get(&url)
      .send()
      .await
      .map_err(|e| format!("{}: {e}", file.name))?;
    // `error_for_status` is spelled out so the two failures users actually hit
    // come with an explanation instead of a bare status code.
    let status = response.status();
    if !status.is_success() {
      let hint = match status.as_u16() {
        403 => " (the CDN refused the request - the download client must send a User-Agent)",
        404 => " (not found in the ModelScope repository - check the file name and revision)",
        _ => "",
      };
      return Err(format!("{}: HTTP {}{hint}", file.name, status.as_u16()));
    }

    let mut sink = std::fs::File::create(&part)
      .map_err(|e| format!("{}: cannot create {}: {e}", file.name, part.display()))?;
    let mut hasher = Sha256::new();
    let mut written: u64 = 0;
    let mut last_emit = Instant::now();

    while let Some(chunk) = response
      .chunk()
      .await
      .map_err(|e| format!("{}: download interrupted: {e}", file.name))?
    {
      sink
        .write_all(&chunk)
        .map_err(|e| format!("{}: write failed: {e}", file.name))?;
      hasher.update(&chunk);
      written += chunk.len() as u64;

      if last_emit.elapsed() >= Duration::from_millis(PROGRESS_THROTTLE_MS) {
        last_emit = Instant::now();
        emit_progress(app, spec, file, written);
      }
    }

    sink
      .flush()
      .map_err(|e| format!("{}: flush failed: {e}", file.name))?;
    drop(sink);
    emit_progress(app, spec, file, written);

    // Verify before the file becomes visible to the runtime.
    if written != file.size {
      let _ = std::fs::remove_file(&part);
      return Err(format!(
        "{}: size mismatch (expected {}, got {written})",
        file.name, file.size
      ));
    }
    let digest = format!("{:x}", hasher.finalize());
    if digest != file.sha256 {
      let _ = std::fs::remove_file(&part);
      return Err(format!(
        "{}: checksum mismatch (the download was discarded)",
        file.name
      ));
    }

    let target = root.join(file.target);
    if let Some(parent) = target.parent() {
      std::fs::create_dir_all(parent)
        .map_err(|e| format!("{}: cannot create {}: {e}", file.name, parent.display()))?;
    }
    std::fs::rename(&part, &target).map_err(|e| {
      let _ = std::fs::remove_file(&part);
      format!("{}: cannot place file: {e}", file.name)
    })?;
  }

  Ok(())
}

fn emit_progress(app: &AppHandle, spec: &GroupSpec, file: &FileSpec, written: u64) {
  let progress = ModelProgress {
    group: spec.id.to_string(),
    file: file.name.to_string(),
    downloaded: written,
    total: file.size,
  };
  set_active(app, Some(progress.clone()));
  let _ = app.emit(PROGRESS_EVENT, progress);
}

// ─── Local import (drag & drop / file picker) ────────────────────────────

/// Every known file name → its spec, used to recognise user-provided files.
fn spec_by_name(name: &str) -> Option<(&'static FileSpec, &'static GroupSpec)> {
  let lower = name.to_ascii_lowercase();
  GROUPS.iter().find_map(|group| {
    group
      .files
      .iter()
      .find(|file| file.name.to_ascii_lowercase() == lower)
      .map(|file| (file, group))
  })
}

/// Copy user-provided model files into `<install dir>/models`.
///
/// Files are recognised by name (a folder is searched recursively), copied
/// - never moved - and verified against the pinned size and SHA-256, so a
/// corrupt or wrong build is reported instead of silently breaking OCR.
pub fn add_local(app: &AppHandle, paths: Vec<String>) -> Result<LocalImportResult, String> {
  if paths.is_empty() {
    return Err("No files were provided".to_string());
  }
  {
    let state = app.state::<ModelsState>();
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_some() {
      return Err("A model download is running - try again once it finishes".to_string());
    }
  }

  let root = models_dir();
  std::fs::create_dir_all(&root)
    .map_err(|e| format!("Failed to create {}: {e}", root.display()))?;

  let mut candidates: Vec<PathBuf> = Vec::new();
  for path in &paths {
    collect_files(Path::new(path), &mut candidates);
  }

  let mut result = LocalImportResult::default();
  for candidate in candidates {
    let name = candidate
      .file_name()
      .map(|n| n.to_string_lossy().to_string())
      .unwrap_or_default();
    let Some((spec, _group)) = spec_by_name(&name) else {
      result.ignored.push(name);
      continue;
    };
    match verify_and_copy(&candidate, spec, &root.join(spec.target)) {
      Ok(()) => result.imported.push(spec.target.to_string()),
      Err(reason) => result.failed.push(format!("{name}: {reason}")),
    }
  }
  Ok(result)
}

/// Depth-first file collection (directories are searched, symlinks are not
/// followed to avoid loops).
fn collect_files(path: &Path, out: &mut Vec<PathBuf>) {
  let Ok(meta) = std::fs::metadata(path) else {
    return;
  };
  if meta.is_file() {
    out.push(path.to_path_buf());
    return;
  }
  if !meta.is_dir() {
    return;
  }
  let Ok(entries) = std::fs::read_dir(path) else {
    return;
  };
  for entry in entries.flatten() {
    collect_files(&entry.path(), out);
  }
}

/// Verify a candidate file against its spec and copy it into place.
fn verify_and_copy(source: &Path, spec: &FileSpec, target: &Path) -> Result<(), String> {
  let meta = std::fs::metadata(source).map_err(|e| e.to_string())?;
  if meta.len() != spec.size {
    return Err(format!(
      "size mismatch (expected {} bytes, got {})",
      spec.size,
      meta.len()
    ));
  }
  let digest = hash_file(source)?;
  if digest != spec.sha256 {
    return Err("checksum mismatch".to_string());
  }
  if let Some(parent) = target.parent() {
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  std::fs::copy(source, target).map_err(|e| e.to_string())?;
  Ok(())
}

fn hash_file(path: &Path) -> Result<String, String> {
  use std::io::Read;
  let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
  let mut hasher = Sha256::new();
  let mut buffer = vec![0u8; 1024 * 1024];
  loop {
    let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
    if read == 0 {
      break;
    }
    hasher.update(&buffer[..read]);
  }
  Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn spec_table_is_consistent() {
    let mut targets: Vec<&str> = Vec::new();
    for group in GROUPS {
      assert!(!group.files.is_empty(), "group {} has no files", group.id);
      for file in group.files {
        assert!(file.size > 0, "{} has no size pin", file.name);
        assert_eq!(file.sha256.len(), 64, "{} sha256 malformed", file.name);
        assert!(
          file.sha256.chars().all(|c| c.is_ascii_hexdigit()),
          "{} sha256 malformed",
          file.name
        );
        assert!(
          !targets.contains(&file.target),
          "duplicate target {}",
          file.target
        );
        targets.push(file.target);
      }
    }
    assert_eq!(GROUPS.len(), 4);
  }

  #[test]
  fn file_names_map_to_their_targets() {
    // Names are matched case-insensitively so a Windows-cased filename works.
    let (spec, group) = spec_by_name("pp-ocrv6_SMALL_rec.MNN").expect("known name");
    assert_eq!(group.id, "ocr.small");
    assert_eq!(spec.target, "PP-OCRv6_small_rec.mnn");
    let (spec, group) = spec_by_name("layout-meta.json").expect("known name");
    assert_eq!(group.id, "layout.PP-DocLayoutV3");
    assert_eq!(spec.target, "layout/PP-DocLayoutV3/layout-meta.json");
    assert!(spec_by_name("random.dll").is_none());
  }

  #[test]
  fn download_urls_are_model_scope_api_links() {
    let url = download_url(MS_LAYOUT_REPO, "PP-DocLayoutV3.mnn");
    assert_eq!(
      url,
      "https://www.modelscope.cn/api/v1/models/tansen87/PP-DocLayoutV3_mnn/repo?Revision=master&FilePath=PP-DocLayoutV3.mnn"
    );
  }
}
