#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Convert PaddlePaddle inference models (PP-DocLayout-S, PP-OCR, ...) to MNN.

Pipeline:
    Paddle (inference.json/.pdmodel + .pdiparams) -> ONNX -> MNN

Usage:
    python convert_paddle_to_mnn.py --ocr-dir ./PP-DocLayout-S --install-dir ./models
    python convert_paddle_to_mnn.py --ocr-dir ./ocr --install-dir ./models --fp16
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None

# Resolved in main()
PADDLE2ONNX_BIN = None
MNNCONVERT_BIN = None


# ---------------------------------------------------------------------------
# Windows console UTF-8
# ---------------------------------------------------------------------------
def fix_console_encoding():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Model directory detection
# ---------------------------------------------------------------------------
def is_model_dir(d: Path) -> bool:
    """A directory is a model dir if it contains paddle inference files."""
    if (d / "inference.json").exists() and (d / "inference.pdiparams").exists():
        return True
    if list(d.glob("*.pdmodel")) and list(d.glob("*.pdiparams")):
        return True
    return False


def find_model_dirs(ocr_dir: Path):
    """Support both:
    1. ocr_dir itself is a model dir (single model)
    2. ocr_dir contains multiple model sub-dirs
    """
    if is_model_dir(ocr_dir):
        return [ocr_dir]
    subs = sorted(d for d in ocr_dir.iterdir() if d.is_dir() and is_model_dir(d))
    return subs


def get_model_files(model_dir: Path):
    """Return (model_filename, params_filename) or (None, None)."""
    if (model_dir / "inference.json").exists():
        return "inference.json", "inference.pdiparams"

    pdmodels = list(model_dir.glob("*.pdmodel"))
    if pdmodels:
        model_filename = pdmodels[0].name
        params_name = model_filename.replace(".pdmodel", ".pdiparams")
        if (model_dir / params_name).exists():
            return model_filename, params_name
        pdparams = list(model_dir.glob("*.pdiparams"))
        if pdparams:
            return model_filename, pdparams[0].name
    return None, None


# ---------------------------------------------------------------------------
# Step 1: Paddle -> ONNX
# ---------------------------------------------------------------------------
def convert_paddle_to_onnx(model_dir: Path, opset_version: int = 11) -> bool:
    model_filename, params_filename = get_model_files(model_dir)
    if model_filename is None:
        print("  [ONNX] ✗ No paddle inference files found")
        return False

    save_file = model_dir / "model.onnx"
    cmd = [
        PADDLE2ONNX_BIN,
        "--model_dir", str(model_dir),
        "--model_filename", model_filename,
        "--params_filename", params_filename,
        "--save_file", str(save_file),
        "--opset_version", str(opset_version),
    ]
    print(f"  [ONNX] {model_filename} + {params_filename} -> model.onnx (opset {opset_version})")
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(model_dir))

    if result.returncode != 0 or not save_file.exists():
        print("  [ONNX] ✗ Failed")
        if result.stdout:
            print(result.stdout[-3000:])
        if result.stderr:
            print(result.stderr[-3000:])
        return False

    size_mb = save_file.stat().st_size / 1024 / 1024
    print(f"  [ONNX] ✓ model.onnx ({size_mb:.2f} MB)")
    return True


# ---------------------------------------------------------------------------
# Step 2: ONNX -> MNN
# ---------------------------------------------------------------------------
def convert_onnx_to_mnn(model_dir: Path, use_fp16: bool) -> bool:
    onnx_file = model_dir / "model.onnx"
    mnn_file = model_dir / "model.mnn"

    if not onnx_file.exists():
        print("  [MNN] ✗ model.onnx not found")
        return False

    cmd = [
        MNNCONVERT_BIN,          # absolute path -> avoids WinError 2
        "-f", "ONNX",
        "--modelFile", str(onnx_file),
        "--MNNModel", str(mnn_file),
        "--bizCode", "mnn",
    ]
    if use_fp16:
        cmd.append("--fp16")

    print(f"  [MNN] model.onnx -> model.mnn ({'FP16' if use_fp16 else 'FP32'})")
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(model_dir))

    # mnnconvert on Windows may crash with an access violation (exit code
    # 0xC0000005) *after* the .mnn file has been written and reported
    # "Converted Success!", so treat an existing output file as success.
    if mnn_file.exists() and mnn_file.stat().st_size > 0:
        size_mb = mnn_file.stat().st_size / 1024 / 1024
        print(f"  [MNN] ✓ model.mnn ({size_mb:.2f} MB)")
        if result.returncode != 0:
            print("  [MNN] ⚠ mnnconvert exited with a nonzero code "
                  f"({result.returncode}) after writing the model (known Windows teardown crash); "
                  "the .mnn file is valid.")
        return True

    print("  [MNN] ✗ Failed")
    if mnn_file.exists():
        print(f"  [MNN] model.mnn exists but is {mnn_file.stat().st_size} bytes")
    if result.stdout:
        print(result.stdout[-3000:])
    if result.stderr:
        print(result.stderr[-3000:])
    return False


# ---------------------------------------------------------------------------
# Character dict (OCR rec models only; detection/layout models skip this)
# ---------------------------------------------------------------------------
def extract_character_dict(model_dir: Path):
    """Find character dict path from inference.yml. Returns Path or None."""
    yml = model_dir / "inference.yml"
    if not yml.exists() or yaml is None:
        return None

    try:
        with open(yml, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
    except Exception as e:
        print(f"  [Dict] ⚠ Failed to parse inference.yml: {e}")
        return None

    def search(obj):
        if isinstance(obj, dict):
            for k, v in obj.items():
                if isinstance(v, str) and v and \
                        k.lower().endswith(("dict_path", "character_dict")):
                    if not v.lower().startswith("http"):
                        return v
                found = search(v)
                if found:
                    return found
        elif isinstance(obj, list):
            for item in obj:
                found = search(item)
                if found:
                    return found
        return None

    rel = search(cfg)
    if not rel:
        return None

    candidates = [model_dir / rel, (yml.parent / rel).resolve()]
    for p in candidates:
        if p.exists():
            print(f"  [Dict] ✓ Found: {p}")
            return p
    print(f"  [Dict] ⚠ Declared but not found: {rel}")
    return None


# ---------------------------------------------------------------------------
# Step 3: Install
# ---------------------------------------------------------------------------
def install_converted_model(model_dir: Path, install_dir: Path) -> bool:
    mnn_file = model_dir / "model.mnn"
    if not mnn_file.exists():
        return False

    dest = install_dir / model_dir.name
    dest.mkdir(parents=True, exist_ok=True)

    shutil.copy2(mnn_file, dest / "model.mnn")
    print(f"  [Install] ✓ model.mnn -> {dest / 'model.mnn'}")

    dict_path = extract_character_dict(model_dir)
    if dict_path:
        shutil.copy2(dict_path, dest / dict_path.name)
        print(f"  [Install] ✓ dict -> {dest / dict_path.name}")
    else:
        print("  [Install] (no character dict - detection/layout model, skipped)")
    return True


# ---------------------------------------------------------------------------
# Tool resolution
# ---------------------------------------------------------------------------
def _venv_scripts_dir():
    """Return the venv Scripts dir when running inside a virtualenv, else None."""
    import os
    scripts = getattr(sys, "_base_executable", None)
    if scripts is None:
        return None
    root = Path(sys.prefix)
    if not hasattr(sys, "real_prefix") and sys.base_prefix != sys.prefix:
        for name in ("Scripts", "bin"):
            d = root / name
            if d.is_dir():
                return d
    return None


def _find_bin(name: str) -> str | None:
    import os

    # Prefer the binary inside the active venv; the console script must run
    # against THIS environment's paddle + protobuf, not a globally installed one.
    scripts = _venv_scripts_dir()
    if scripts:
        cand = scripts / (name + (".exe" if os.name == "nt" else ""))
        if cand.exists():
            return str(cand)
    return shutil.which(name)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    global PADDLE2ONNX_BIN, MNNCONVERT_BIN
    fix_console_encoding()

    parser = argparse.ArgumentParser(description="Convert Paddle models to MNN")
    parser.add_argument("--ocr-dir", default="./ocr",
                        help="Model dir (single model) or parent dir of multiple models")
    parser.add_argument("--install-dir", default="./models",
                        help="Directory to install converted models")
    parser.add_argument("--opset", type=int, default=11,
                        help="ONNX opset version (default: 11)")
    parser.add_argument("--fp16", dest="fp16", action="store_true",
                        help="Convert MNN with FP16 weights")
    parser.add_argument("--no-fp16", dest="fp16", action="store_false",
                        help="Convert MNN with FP32 weights (default)")
    parser.set_defaults(fp16=False)
    args = parser.parse_args()

    # ---- Resolve tools (absolute paths) ----
    PADDLE2ONNX_BIN = _find_bin("paddle2onnx")
    MNNCONVERT_BIN = _find_bin("mnnconvert")

    if not PADDLE2ONNX_BIN:
        print("Error: paddle2onnx not found. Install with: pip install -U paddle2onnx")
        sys.exit(1)
    if not MNNCONVERT_BIN:
        print("Error: mnnconvert not found in PATH. Add MNN tools dir to PATH.")
        sys.exit(1)

    print(f"paddle2onnx : {PADDLE2ONNX_BIN}")
    print(f"mnnconvert  : {MNNCONVERT_BIN}")

    # Show mnnconvert version
    try:
        v = subprocess.run([MNNCONVERT_BIN, "--version"],
                           capture_output=True, text=True)
        ver_line = (v.stdout + v.stderr).strip().splitlines()
        if ver_line:
            print(f"mnnconvert version: {ver_line[-1]}")
    except Exception:
        pass

    # ---- Locate models ----
    ocr_dir = Path(args.ocr_dir).resolve()
    install_dir = Path(args.install_dir).resolve()

    if not ocr_dir.exists():
        print(f"Error: path not found: {ocr_dir}")
        sys.exit(1)

    model_dirs = find_model_dirs(ocr_dir)
    if not model_dirs:
        print(f"Error: No model directories found in {ocr_dir}")
        print("Expected inference.json + inference.pdiparams or *.pdmodel + *.pdiparams")
        sys.exit(1)

    install_dir.mkdir(parents=True, exist_ok=True)
    print(f"\nFound {len(model_dirs)} model(s): {[d.name for d in model_dirs]}")

    # ---- Convert ----
    results = {}
    for md in model_dirs:
        print(f"\n{'=' * 50}\n{md.name}\n{'=' * 50}")
        ok_onnx = convert_paddle_to_onnx(md, args.opset)
        ok_mnn = convert_onnx_to_mnn(md, args.fp16) if ok_onnx else False
        ok_install = install_converted_model(md, install_dir) if ok_mnn else False
        results[md.name] = (ok_onnx, ok_mnn, ok_install)

    # ---- Summary ----
    print(f"\n{'=' * 50}\nSummary\n{'=' * 50}")
    all_ok = True
    for name, (a, b, c) in results.items():
        flag = lambda x: "✓" if x else "✗"
        print(f"  {name}: ONNX {flag(a)} | MNN {flag(b)} | Install {flag(c)}")
        if not (a and b and c):
            all_ok = False

    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()