//! One-time, idempotent migration from the legacy resource layout to the
//! flattened one (docs/design/00020_update-check-and-install-layout.md §3.4.4).
//!
//! Legacy (<= 0.2.x) layout:
//!
//! ```text
//! <install>/doccraft_resources/models/...   bundled tiers + user models
//! <install>/doccraft_resources/data/...     ocr-config.json, app-settings.json, usage log
//! ```
//!
//! Flattened layout:
//!
//! ```text
//! <install>/models/...   <install>/data/...
//! ```
//!
//! Rules: **only add, never overwrite, never delete**. Running this on every
//! start is safe - it becomes a no-op as soon as the legacy directory is gone
//! and every target file already exists.

use std::path::Path;

use crate::core::{data_dir, install_dir, models_dir};

/// Name of the legacy wrapper directory that used to hold everything.
const LEGACY_DIR: &str = "doccraft_resources";

/// Copy the legacy `doccraft_resources/{models,data}` trees into the
/// flattened locations. Returns the number of files copied (0 = nothing to do).
pub fn migrate_once() -> usize {
  let legacy = install_dir().join(LEGACY_DIR);
  if !legacy.is_dir() {
    return 0;
  }
  let mut copied = 0;
  // `models` carries the bundled tiers plus anything the user dropped in by
  // hand (e.g. the medium tier or a downloaded layout model) - copy_missing
  // keeps the shipped files and only fills the gaps.
  copied += copy_missing(&legacy.join("models"), &models_dir());
  copied += copy_missing(&legacy.join("data"), &data_dir());
  if copied > 0 {
    eprintln!(
      "[migrate] flattened {copied} file(s) from {} into the install directory",
      legacy.display()
    );
  }
  copied
}

/// Recursively copy `src` into `dest`, skipping any file that already exists
/// at the destination. Returns the number of files copied.
fn copy_missing(src: &Path, dest: &Path) -> usize {
  let Ok(entries) = std::fs::read_dir(src) else {
    return 0;
  };
  let mut copied = 0;
  for entry in entries.flatten() {
    let from = entry.path();
    let to = dest.join(entry.file_name());
    if from.is_dir() {
      copied += copy_missing(&from, &to);
      continue;
    }
    if to.exists() {
      continue;
    }
    if let Some(parent) = to.parent() {
      if std::fs::create_dir_all(parent).is_err() {
        continue;
      }
    }
    if std::fs::copy(&from, &to).is_ok() {
      copied += 1;
    }
  }
  copied
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Unique scratch directory per test run.
  fn scratch(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("doccraft-migrate-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create scratch");
    dir
  }

  fn write(path: &Path, body: &str) {
    if let Some(parent) = path.parent() {
      std::fs::create_dir_all(parent).expect("create parent");
    }
    std::fs::write(path, body).expect("write file");
  }

  #[test]
  fn missing_source_is_a_noop() {
    let root = scratch("noop");
    let copied = copy_missing(&root.join("absent"), &root.join("dest"));
    assert_eq!(copied, 0);
    assert!(!root.join("dest").exists());
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn copies_nested_files_but_keeps_existing_ones() {
    let root = scratch("nested");
    let src = root.join("src");
    let dest = root.join("dest");
    write(
      &src.join("models/layout/PP-DocLayoutV3/PP-DocLayoutV3.mnn"),
      "125MB",
    );
    write(&src.join("models/PP-OCRv6_small_det.mnn"), "shipped");
    write(&src.join("models/overridden.mnn"), "legacy");
    // Destination already carries the shipped tier and its own version of the
    // third file: neither may be overwritten.
    write(&dest.join("models/PP-OCRv6_small_det.mnn"), "package");
    write(&dest.join("models/overridden.mnn"), "newer");

    let copied = copy_missing(&src.join("models"), &dest.join("models"));

    assert_eq!(copied, 1, "only the layout model was missing");
    assert_eq!(
      std::fs::read_to_string(dest.join("models/PP-OCRv6_small_det.mnn")).unwrap(),
      "package"
    );
    assert_eq!(
      std::fs::read_to_string(dest.join("models/overridden.mnn")).unwrap(),
      "newer"
    );
    assert_eq!(
      std::fs::read_to_string(dest.join("models/layout/PP-DocLayoutV3/PP-DocLayoutV3.mnn"))
        .unwrap(),
      "125MB"
    );
    let _ = std::fs::remove_dir_all(&root);
  }
}
