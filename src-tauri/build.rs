use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

fn main() {
  tauri_build::build();
  sync_resources();
}

/// Mirror `src-tauri/resources/` into `<target>/<profile>/doccraft_resources/`
/// so the runtime layout (`exe_dir/doccraft_resources`, see
/// `core::get_resources_dir`) is populated for dev / non-bundled builds.
///
/// The folder is not wired through Tauri's bundler `resources` config, so
/// without this every new model file had to be copied by hand (which is how
/// the small PaddleOCR tier went missing and OCR failed with "系统找不到指定
/// 的文件"). Files are copied only when missing or older than the source.
fn sync_resources() {
  let manifest_dir =
    PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set"));
  let src = manifest_dir.join("resources");
  if !src.is_dir() {
    return;
  }

  // OUT_DIR = <target>/<profile>/build/<pkg>-<hash>/out → walk up to
  // <target>/<profile>.
  let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR not set"));
  let Some(dest_root) = out_dir.ancestors().nth(3).map(Path::to_path_buf) else {
    return;
  };
  let dest_root = dest_root.join("doccraft_resources");

  if copy_tree(&src, &dest_root) {
    println!("cargo:rerun-if-changed=resources");
  }
}

/// Recursively copy `src` into `dest`. Returns true when at least one file
/// was copied.
fn copy_tree(src: &Path, dest: &Path) -> bool {
  let mut copied = false;
  let Ok(entries) = fs::read_dir(src) else {
    return false;
  };
  for entry in entries.flatten() {
    let from = entry.path();
    let to = dest.join(entry.file_name());
    if from.is_dir() {
      copied |= copy_tree(&from, &to);
      continue;
    }
    let needs_copy = match (fs::metadata(&to), fs::metadata(&from)) {
      (Ok(d), Ok(s)) => modified_time(&s) > modified_time(&d),
      _ => true,
    };
    if needs_copy {
      if let Some(parent) = to.parent() {
        let _ = fs::create_dir_all(parent);
      }
      if fs::copy(&from, &to).is_ok() {
        copied = true;
      }
    }
  }
  copied
}

fn modified_time(meta: &fs::Metadata) -> SystemTime {
  meta.modified().unwrap_or(SystemTime::UNIX_EPOCH)
}
