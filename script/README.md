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

---

<a id="convert_paddle_to_mnnpy-中文"></a>
# convert_paddle_to_mnn.py

把 PaddlePaddle inference 模型（PP-DocLayout-S / PP-OCR 等）转换成 MNN 模型。

转换流程：

```
Paddle (inference.json / .pdmodel + .pdiparams)  --paddle2onnx-->  ONNX  --mnnconvert-->  MNN
```

转换工具由 `paddle2onnx` 与 `mnn` 两个 Python 包提供（它们会安装 `paddle2onnx` 和 `mnnconvert` 命令行程序），运行时还会用到 `paddlepaddle` 与 `PyYAML`。所有依赖已锁定在 [`pyproject.toml`](./pyproject.toml) 中。

## 前置要求

- Python >= 3.9（本仓库使用 Python 3.11）
- [uv](https://docs.astral.sh/uv/)（推荐，用于创建虚拟环境）或 pip

> ⚠️ **版本坑**：模型文件是 Paddle 3.x 的 `inference.json` JSON-program 格式，必须用 paddle 3.x 转换。
> 且 `paddle2onnx 2.1.0` 在 Windows 上**明确拒绝**稳定版 `paddlepaddle==3.0.0`
> （见 `paddle2onnx/__init__.py`），所以 Windows 上强制 `paddlepaddle>=3.1.0`。
> 这些约束已写入 `pyproject.toml`，用它建环境即可自动避开。

## 虚拟环境搭建（uv）

在 `script/` 目录下执行：

```bash
cd script

# 只装转换所需依赖（paddle + paddle2onnx + mnn + PyYAML）
uv venv
uv pip install -e .

# 若同时需要 paddleocr / paddlex 完整栈（与目录里的 JSON 模型匹配）
uv pip install -e ".[full]"
```

pip 方式等同：

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -e .            # 或 pip install -e ".[full]"
```

> 注意：脚本通过 `sys.prefix` 自动定位 `.venv\Scripts` 下的 `paddle2onnx` / `mnnconvert`
> 二进制，即使不手动激活虚拟环境也能直接运行（见 `convert_paddle_to_mnn.py` 中的 `_find_bin`）。

## 用法

```bash
# 转换单个模型目录并安装到 ./models
python convert_paddle_to_mnn.py --ocr-dir ./PP_DocLayout_S --install-dir ./models

# 转换父目录下的多个模型（自动发现所有子模型目录）
python convert_paddle_to_mnn.py --ocr-dir ./ocr --install-dir ./models

# 使用 FP16 权重（可减小模型体积）
python convert_paddle_to_mnn.py --ocr-dir ./PP_DocLayout_S --install-dir ./models --fp16
```

完整参数：

```
--ocr-dir       模型目录（单个模型）或包含多个子模型目录的父目录（默认 ./ocr）
--install-dir   转换结果的安装目录（默认 ./models）
--fp16 / --no-fp16    MNN 权重精度（默认 FP16 关闭 = FP32）
--opset         ONNX opset 版本（默认 11）
```

## 支持的模型目录格式

每个模型目录需满足以下任一条件：

- 包含 `inference.json` + `inference.pdiparams`（Paddle 3.x JSON-program 格式）
- 包含 `*.pdmodel` + `*.pdiparams`（旧版二进制格式）

父目录模式下，脚本会扫描所有符合上述条件的子目录并批量转换。

## 输出 / 安装

每个模型目录内生成 `model.onnx` 与 `model.mnn`；`--install-dir` 会把 `model.mnn` 复制为
`<install-dir>/<模型目录名>/model.mnn`。若 `inference.yml` 中声明了字符字典（OCR 识别模型），
字典文件也会一并复制；检测/版面模型无字典，会自动跳过该步骤。

## 已知问题

**mnnconvert 在 Windows 上的退出崩溃**

`mnnconvert`（MNN 3.6.1 Windows wheel）在**成功写出 `model.mnn` 之后**、退出清理阶段会触发
原生访问违规（退出码 `0xC0000005` = 3221225477）。模型文件本身完整有效。脚本已做容错：
只要 `model.mnn` 存在且非空即判定成功，并打印一条警告。若看到类似警告可忽略。

```
Converted Success!
[MNN] ✓ model.mnn (4.57 MB)
[MNN] ⚠ mnnconvert exited with a nonzero code (3221225477) after writing the model (known Windows teardown crash); the .mnn file is valid.
```
