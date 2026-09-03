use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

fn main() {
  tauri_build::build();
  sync_resources();
  build_mnn_v3();
}

/// Build the standalone MNN wrapper + link MNN for the PP-DocLayoutV3 DETR
/// layout model. It links the same MNN static library used by `ocr-rs`, but
/// through our own wrapper so the input tensor is selected by name ("image")
/// instead of `ocr_rs`'s alphabetically-first-input binding.
fn build_mnn_v3() {
  let manifest_dir =
    PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set"));
  // MNN lives at `<repo>/cpp/mnn` (sibling of `src-tauri`).
  let mnn = manifest_dir
    .parent()
    .map(Path::to_path_buf)
    .unwrap_or(manifest_dir)
    .join("cpp")
    .join("mnn");
  let include_dir = mnn.join("include");
  let lib_dir = mnn.join("lib");
  if !include_dir.is_dir() || !lib_dir.join("MNN.lib").is_file() {
    println!("cargo:warning=MNN not vendored (cpp/mnn); PP-DocLayoutV3 runtime disabled");
    return;
  }

  let mut build = cc::Build::new();
  build.cpp(true);
  match std::env::var("CARGO_CFG_TARGET_ENV").as_deref() {
    Ok("msvc") => {
      build.flag("/std:c++14").flag("/EHsc");
      // MNN prebuilt `.lib` is compiled with a static CRT; match it to avoid
      // LNK2038 RuntimeLibrary mismatches (same as ocr-rs's build.rs).
      build.static_crt(true);
    }
    _ => {
      build.flag("-std=c++14");
    }
  }
  build
    .file(mnn.join("mnn_v3_wrapper.cpp"))
    .include(&include_dir)
    .compile("mnn_v3_wrapper");

  println!("cargo:rerun-if-changed=cpp/mnn/mnn_v3_wrapper.cpp");
  println!("cargo:rerun-if-changed=cpp/mnn/include");

  // Link the wrapper archive and MNN by absolute path: build-script
  // `rustc-link-lib` is not reliably re-emitted for example targets, so these
  // `rustc-link-arg` flags pass both `.lib` files straight to the linker for
  // every linked target (examples and the final app binary).
  let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR not set");
  println!("cargo:rustc-link-search=native={}", lib_dir.display());
  println!("cargo:rustc-link-search=native={out_dir}");
  println!("cargo:rustc-link-lib=static=mnn_v3_wrapper");
  println!("cargo:rustc-link-lib=static=MNN");
  println!("cargo:rustc-link-arg={out_dir}/mnn_v3_wrapper.lib");
  println!("cargo:rustc-link-arg={}/MNN.lib", lib_dir.display());
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
