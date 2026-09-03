# convert_paddle_to_mnn.py

English | [中文](./README_ZH.md)

Convert PaddlePaddle inference models (PP-DocLayout-S / PP-OCR, etc.) into MNN models.

Conversion pipeline:

```
Paddle (inference.json / .pdmodel + .pdiparams)  --paddle2onnx-->  ONNX  --mnnconvert-->  MNN
```

The conversion tools are provided by the `paddle2onnx` and `mnn` Python packages (which install the `paddle2onnx` and `mnnconvert` command-line programs). At runtime, `paddlepaddle` and `PyYAML` are also required. All dependencies are locked in [`pyproject.toml`](./pyproject.toml).

## Prerequisites

- Python >= 3.9 (this repo uses Python 3.11)
- [uv](https://docs.astral.sh/uv/) (recommended, for creating virtual environments) or pip

> ⚠️ **Version pitfall**: The model files use the Paddle 3.x `inference.json` JSON-program format and must be converted with paddle 3.x. Moreover, `paddle2onnx 2.1.0` explicitly **rejects** the stable `paddlepaddle==3.0.0` on Windows (see `paddle2onnx/__init__.py`), so Windows requires `paddlepaddle>=3.1.0`. These constraints are already declared in `pyproject.toml`; building the environment from it will avoid the pitfalls automatically.

## Virtual Environment Setup (uv)

Run the following inside the `script/` directory:

```bash
cd script

# Install only the dependencies required for conversion (paddle + paddle2onnx + mnn + PyYAML)
uv venv
uv pip install -e .

# If you also need the full paddleocr / paddlex stack (matching the JSON models in the directory)
uv pip install -e ".[full]"
```

The pip equivalent:

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -e .            # or pip install -e ".[full]"
```

> Note: The script automatically locates the `paddle2onnx` / `mnnconvert` binaries under `.venv\Scripts` via `sys.prefix`, so it can run directly even without manually activating the virtual environment (see `_find_bin` in `convert_paddle_to_mnn.py`).

## Usage

```bash
# Convert a single model directory and install it to ./models
python convert_paddle_to_mnn.py --ocr-dir ./PP_DocLayout_S --install-dir ./models

# Convert multiple models under a parent directory (all sub-model directories are discovered automatically)
python convert_paddle_to_mnn.py --ocr-dir ./ocr --install-dir ./models

# Use FP16 weights (reduces model size)
python convert_paddle_to_mnn.py --ocr-dir ./PP_DocLayout_S --install-dir ./models --fp16
```

Full options:

```
--ocr-dir       Model directory (single model) or a parent directory containing multiple sub-model directories (default: ./ocr)
--install-dir   Installation directory for the conversion results (default: ./models)
--fp16 / --no-fp16    MNN weight precision (default: FP16 off = FP32)
--opset         ONNX opset version (default: 11)
```

## Supported Model Directory Formats

Each model directory must satisfy one of the following:

- Contains `inference.json` + `inference.pdiparams` (Paddle 3.x JSON-program format)
- Contains `*.pdmodel` + `*.pdiparams` (legacy binary format)

In parent-directory mode, the script scans all subdirectories matching the above conditions and converts them in batch.

## Output / Installation

Each model directory produces `model.onnx` and `model.mnn`; `--install-dir` copies `model.mnn` to `<install-dir>/<model-directory-name>/model.mnn`. If the character dictionary is declared in `inference.yml` (OCR recognition models), the dictionary file is copied as well; detection/layout models have no dictionary and this step is skipped automatically.

## Known Issues

**mnnconvert exit crash on Windows**

`mnnconvert` (MNN 3.6.1 Windows wheel) triggers a native access violation (exit code `0xC0000005` = 3221225477) during the exit-cleanup phase **after successfully writing `model.mnn`**. The model file itself is complete and valid. The script handles this gracefully: as long as `model.mnn` exists and is non-empty, the conversion is treated as successful and a warning is printed. Such warnings can be ignored.

```
Converted Success!
[MNN] ✓ model.mnn (4.57 MB)
[MNN] ⚠ mnnconvert exited with a nonzero code (3221225477) after writing the model (known Windows teardown crash); the .mnn file is valid.
```
