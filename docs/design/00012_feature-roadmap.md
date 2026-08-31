# 功能路线图：可扩展功能提案

状态：待评审
关联：[../index.md](../index.md)（项目结构与现状）、[00009_feature-expansion-proposals.md](./00009_feature-expansion-proposals.md)（已有提案清单）、[00010_pdf-exclude-region.md](./00010_pdf-exclude-region.md)、[00011_draw-line-exclude-region.md](./00011_draw-line-exclude-region.md)

---

## 1. 背景与方法

本文档基于对 `docs/index.md` 项目结构、全部已有 design 文档（00001–00011）及源码 IPC 合约的逐项审计，识别出当前尚未覆盖的功能空白。已落地的功能（PDF→MD、MD→XLSX、图片→MD、截图识别、绘制表格、排除区域、批量队列、双语 UI、配置备份、使用统计、更新检查、自定义 Prompt、页码范围、页级对照等）不再重复列出。

提案分级：

| 等级 | 含义 |
|------|------|
| **P0** | 高收益、低成本，复用现有链路，无新依赖 |
| **P1** | 体验与可靠性补强，涉及中等改动 |
| **P2** | 较大改动或引入新依赖，需单独评审 |

---

## 2. P0 — 高收益低成本

### 2.1 Markdown 编辑器内联编辑 (不需要)

**现状**：`preview-pane.tsx` 只读渲染 Markdown（rendered / raw 两栏），转换结果不可编辑。用户发现 OCR 识别错误后只能导出 `.md` 再用外部编辑器修改。

**方案**：

1. raw 预览栏切换为轻量可编辑 `textarea`（或 `contentEditable`），编辑后的文本实时同步到 rendered 预览栏。
2. 编辑状态持久化到组件内存（切换 tab 不丢失），导出时使用编辑后内容。
3. 底部状态栏显示"已编辑"标记（`edited` badge），鼠标悬停显示改动统计（字符数差异）。

**验收**：在 raw 栏修改任意一行文本，rendered 栏实时更新；导出的 `.md` 文件包含编辑后内容；切换 tab 再回来编辑内容仍在。

**影响范围**：`src/components/pdf2md/preview-pane.tsx`（核心改动）、`src/views/image-to-md.tsx`（图片结果复用同一组件）、`src/i18n/translations.ts`（新增编辑相关文案）。

---

### 2.2 转换历史记录 (不需要)

**现状**：转换结果仅在当前会话可用，关闭窗口后丢失。用户需要重新转换同一文件才能再次获取结果。

**方案**：

1. 后端新增 `core/history.rs`，以 JSONL 追加式写入配置目录下 `convert-history.jsonl`，逐行含：日期时间、源文件路径、文件类型（pdf/image/md）、转换结果摘要（页数、OCR 页数、引擎、耗时）、输出文件路径（如已导出）。
2. 新增 `get_history` / `clear_history` 两个 Tauri 命令。
3. 设置页"使用统计"卡片旁新增"转换历史"只读列表（最近 50 条），每条可点击"重新打开"（将源文件重新载入对应工作区）。
4. 历史独立成文件，`export_config` / `import_config` 不触碰。

**验收**：执行一轮转换+导出后，历史列表出现对应条目，字段与实际吻合；清空历史后列表为空；配置导入导出不影响历史文件。

**影响范围**：`src-tauri/src/core/history.rs`（新增）、`src-tauri/src/lib.rs`（注册命令）、`src/lib/ipc.ts` + `types.ts`、`src/views/settings.tsx`（历史列表 UI）。

---

### 2.3 Markdown 全文搜索与高亮 (不需要)

**现状**：转换后的大文档（数百页）只能在预览中滚动浏览，无法快速定位特定内容。

**方案**：

1. preview-pane header 新增搜索输入框（`Ctrl+F` / `Cmd+F` 聚焦）。
2. 在 raw 文本中匹配关键词，所有命中行高亮；rendered 预览中对应 DOM 节点加 highlight 标记。
3. `Enter` / `Shift+Enter` 在命中结果间跳转（上一个 / 下一个），状态栏显示"N/M"（当前/总数）。
4. 搜索范围遵循当前分页逻辑（只搜已渲染页 + 缓存的 raw 全文）。

**验收**：输入关键词后所有匹配高亮可见；跳转精确滚动到匹配位置；清空搜索后高亮移除；大文档（500+页）搜索响应 ≤500ms。

**影响范围**：`src/components/pdf2md/preview-pane.tsx`（核心改动）、`src/lib/utils.ts`（高亮工具函数）、`src/i18n/translations.ts`。

---

### 2.4 文件拖拽排序与优先级标记 (不需要)

**现状**：批量队列（`pdf-to-md.tsx` / `md-to-xlsx.tsx`）按添加顺序处理，用户无法调整优先级。紧急文件排在前面的长文件后面只能等待。

**方案**：

1. 批量列表项支持拖拽排序（利用 HTML5 drag API 或 `@dnd-kit`，零或轻量依赖）。
2. 右键菜单或行内按钮"置顶"——将该文件移到队列首位。
3. 正在转换中的文件不可拖动（视觉锁定 + 半透明）。
4. 排序变化仅影响待处理队列，已完成项不动。

**验收**：拖拽重新排列后处理顺序随之改变；"置顶"按钮将文件移到首位且下一轮立即处理；正在转换的文件不可移动。

**影响范围**：`src/views/pdf-to-md.tsx`、`src/views/md-to-xlsx.tsx`、`src/views/image-to-md.tsx`（三个批量列表统一改动）。

---

## 3. P1 — 体验与可靠性补强

### 3.1 PDF 页面旋转与裁剪 (不需要)

**现状**：`pdf-preview.tsx` 直接渲染 PDF 原始页面，旋转/歪斜的页面（扫描件常见）无法校正，影响 OCR 识别率和预览体验。排除区域和绘制表格也因页面旋转而坐标偏移。

**方案**：

1. 预览工具栏新增旋转按钮（左转 90° / 右转 90°），旋转状态存储在组件内存中。
2. 渲染 OCR 页面 PNG 时应用旋转（在 `render-pdf-pages.ts` 的 canvas 绘制阶段加 `ctx.rotate`），后端 OCR 接收已校正的图像。
3. 排除区域坐标和绘制线条坐标在旋转后自动转换（已有 `canvas-overlay.tsx` 的坐标换算基础设施）。
4. 旋转状态不修改原始 PDF 文件，仅在会话内生效。

**验收**：旋转页面后 OCR 识别率明显提升（对比旋转前后的识别结果）；排除区域和绘制线条在旋转后仍精确对应页面位置；导出的 Markdown 内容来自旋转后的页面。

**影响范围**：`src/components/pdf2md/pdf-preview.tsx`、`src/components/pdf2md/render-pdf-pages.ts`、`src/components/draw-table/canvas-overlay.tsx`、`src/components/pdf2md/exclude-overlay.tsx`。

---

### 3.2 批量任务暂停 / 恢复

**现状**：批量队列运行后只能逐个移除或等待完成，无法暂停。长时间批量转换（几十个 OCR 文件）期间如需释放 CPU 资源只能杀进程。

**方案**：

1. 队列工具栏新增"暂停 / 恢复"按钮。
2. 暂停时：当前正在转换的文件完成后停止取下一个任务；worker pool 进入 idle。
3. 恢复时：从队列中下一个待处理文件继续。
4. 暂停状态持久化到 `app-settings.json`（`batchPaused: boolean`），意外关闭后重开可恢复。

**验收**：暂停后当前文件完成后不再取新任务，CPU 占用归零；恢复后从下一个文件继续处理；关闭窗口再打开后暂停状态保留。

**影响范围**：`src/lib/concurrency.ts`（worker pool 控制）、`src/views/pdf-to-md.tsx`、`src/views/image-to-md.tsx`、`src/views/md-to-xlsx.tsx`、`src-tauri/src/core/settings.rs`（新增 `batch_paused` 字段）。

---

### 3.3 Excel 导出格式化选项 (不需要)

**现状**：`md_to_xlsx.rs` 导出为纯文本 `.xlsx`，无样式。表格表头与数据行视觉无差异，多表格在同一 sheet 中无分隔标题。

**方案**：

1. `AppSettings` 新增 `excelHeaderStyle`（`none` / `bold` / `fill`），表头行加粗或背景色填充。
2. 多表格导出时每个表格上方写入来源标签行（`Page N` 或 `Table N`，灰色斜体）。
3. 列宽自适应（根据内容长度估算，`rust_xlsxwriter` 支持 `set_column_width`）。
4. 设置页 Excel 区域新增格式化选项开关。

**验收**：开启表头样式后导出的 Excel 表头行视觉区分明显；多表格之间有来源标签行；列宽不出现截断（内容完整可见）。

**影响范围**：`src-tauri/src/core/md_to_xlsx.rs`（核心改动）、`src-tauri/src/core/settings.rs`、`src/lib/types.ts`、`src/views/settings.tsx`。

---

### 3.4 OCR 结果置信度展示与低置信度标记 (已完成)

**现状**：本地 PaddleOCR 引擎返回的识别结果没有置信度信息暴露给前端。用户无法判断哪些 OCR 结果可能不准确。

**方案**：

1. 后端 `ocr.rs` 在本地 OCR 路径中提取 `ocr-rs` 返回的 confidence 分数（如果 API 支持），取页面平均置信度。
2. 远程 AI 路径无置信度——默认标记为 `N/A`。
3. `OcrImageResult` / `ConvertResult` 新增 `ocrConfidence` 字段（`f32 | null`）。
4. 状态栏已有 confidence 显示位置（`status-bar.tsx`），扩展为 OCR 置信度；低于阈值（如 0.7）时标黄/标红并加入 notices。

**验收**：本地 OCR 转换后状态栏显示置信度百分比；低置信度页面在 notices 中标记警告；远程 AI 路径显示"N/A"。

**影响范围**：`src-tauri/src/core/ocr.rs`、`src-tauri/src/models.rs`、`src/lib/types.ts`、`src/components/pdf2md/status-bar.tsx`。

---

### 3.5 快捷键体系 (不需要)

**现状**：仅有截图热键（`F8`）一个全局快捷键。应用内的所有操作（转换、导出、切换 tab、搜索等）都需要鼠标点击。

**方案**：

1. 应用内快捷键（非全局，仅窗口聚焦时生效）：

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+O` | 打开文件（PDF / 图片 / MD） |
| `Ctrl+Enter` | 开始转换 |
| `Ctrl+E` | 导出当前结果 |
| `Ctrl+F` | 搜索（配合 2.3） |
| `Ctrl+1/2/3/4` | 切换四个 tab |
| `Ctrl+,` | 打开设置 |
| `Esc` | 取消当前操作 / 关闭对话框 |

2. 快捷键绑定在 `App.tsx` 根组件统一注册（`useEffect` + `keydown` 监听），分发到当前活跃 tab。
3. 设置页新增"快捷键"分区，显示当前绑定（只读，暂不支持自定义）。

**验收**：每个快捷键在对应场景下触发正确功能；窗口失焦后快捷键不触发；对话框打开时 `Esc` 关闭对话框。

**影响范围**：`src/App.tsx`（全局注册）、各 view 和 component（接收快捷键事件）、`src/views/settings.tsx`（展示页）、`src/i18n/translations.ts`。

---

## 4. P2 — 较大改动

### 4.1 Markdown 多格式导出（DOCX / HTML）(不需要)

> 来源：00009 §4.1 已提出，本文重申并细化。

**现状**：导出格式仅 `.md` 和 `.xlsx`。

**方案**：

1. **HTML 导出**（低风险）：前端 `react-markdown` 已有渲染能力，将 rendered HTML 序列化为完整 HTML 文件（内联 CSS），后端写入磁盘。新增 `export_markdown_html` 命令。
2. **DOCX 导出**（需评估）：候选纯 Rust 库 `docx-rs`，需验证表格还原度（合并单元格、列宽）。若 `docx-rs` 表格支持不足，可先用 HTML 中转 + 用户手动转换。

**验收**：HTML 导出在浏览器中打开后排版与应用内预览一致（标题层级、表格、代码块、列表）；DOCX 导出的表格结构正确。

**影响范围**：`src-tauri/src/core/` 新增导出模块、`src-tauri/Cargo.toml`（可能新增 `docx-rs` 依赖）、`src/lib/ipc.ts` + `types.ts`。

---

### 4.2 Word → Markdown（不需要）

**现状**：应用只支持 PDF / 图片 → Markdown。大量用户原始材料是 `.docx` 格式。

**方案**：

1. 新增独立 tab "Word → MD"或集成到现有 PDF → MD 工作区（自动检测 `.docx` 后缀）。
2. 纯 Rust 解析方案：`docx-rs` 读取 `.docx`，提取段落、标题样式、表格、列表，映射为 Markdown 语法。
3. 复杂排版（文本框、嵌入图片、修订标记）降级为纯文本 + 注释标记。
4. 批量队列复用现有基础设施。

**验收**：标准 `.docx`（含标题、段落、表格、有序/无序列表）转换为 Markdown 后结构正确；嵌入图片降级为 `<!-- image: filename -->` 注释。

**影响范围**：`src-tauri/Cargo.toml`（新增 `docx-rs`）、`src-tauri/src/core/docx_to_md.rs`（新增）、`src/views/` 新增视图或扩展现有视图、`src/App.tsx`（tab 扩展）。

---

### 4.3 PDF 合并与拆分 (不需要)

**现状**：用户需要先用外部工具拆分/合并 PDF，再导入 DocCraft 转换。

**方案**：

1. 新增"PDF 工具"入口（可作为 PDF → MD 工作区的二级功能或独立 tab）。
2. **拆分**：输入页码范围（复用已有 `grid_rebuild::parse_page_range`），后端用 `lopdf`（`pdf-inspector` 已依赖）写入子 PDF。
3. **合并**：多文件拖入，后端按顺序合并为一个 PDF。
4. 拆分/合并后的 PDF 可直接进入转换流程（无缝衔接）。

**验收**：拆分后的子 PDF 页数和内容与指定范围一致；合并后的 PDF 页数为各文件页数之和且顺序正确；拆分/合并后可直接转换。

**影响范围**：`src-tauri/src/core/pdf_tools.rs`（新增）、`src-tauri/Cargo.toml`（`lopdf` 已传递依赖，需确认直接可用）、前端新增工具 UI。

---

### 4.4 插件化 OCR 引擎扩展 (不需要)

**现状**：OCR 引擎固定为本地 PaddleOCR（`ocr-rs`）和远程 OpenAI-compatible vision API 两种。用户无法接入其他 OCR 服务（如百度 OCR、腾讯 OCR、Azure Document Intelligence）。

**方案**：

1. 定义 OCR 引擎 trait（`OcrEngine`），本地和远程 AI 为两个实现。
2. 远程 AI 实现支持自定义请求模板（URL pattern、request body template、response parser），通过设置页配置。
3. 预置常见服务商模板（百度通用文字识别、腾讯 OCR、Azure DI），用户填入 API Key 即可。
4. 模板存储在 `ocr-config.json` 中，随配置备份/恢复迁移。

**验收**：使用百度 OCR 模板 + API Key 后，forceAi 模式正确识别文字；自定义模板的请求/响应格式正确解析；切换回 OpenAI-compatible 模式不影响现有行为。

**影响范围**：`src-tauri/src/core/ocr.rs`（重构引擎抽象）、`src-tauri/src/core/settings.rs`（模板存储）、`src/views/settings.tsx`（引擎配置 UI）、`src/lib/types.ts`。

---

### 4.5 协作标注与结果分享 (不需要)

**现状**：转换结果仅本地可用，团队成员间分享需要导出文件再传输。

**方案**：

1. Markdown 预览区支持添加行内标注（选中文本 → 添加评论/高亮标记），标注存储为 sidecar JSON 文件（`<filename>.annotations.json`）。
2. 导出时可选择"含标注的 Markdown"（标注以 `> [⚠️ comment]` blockquote 形式内联）或纯文本。
3. 分享：将 Markdown + 标注打包为单个 `.zip` 或生成只读 HTML 快照（配合 4.1 的 HTML 导出）。

**验收**：选中文本添加评论后，标注在重新打开文件时仍可见；导出含标注的 Markdown 中评论以 blockquote 形式出现在对应位置。

**影响范围**：前端新增标注组件、`src-tauri/src/core/` 新增标注序列化模块、`src-tauri/src/lib.rs`（标注读写命令）。
