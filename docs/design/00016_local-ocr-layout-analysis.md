# 本地 OCR 版面分析（Layout Analysis）方案

状态标记：◐ 部分实施（2026-09-01）

> 已落地：设置项三档（off/rule/paddle）+ 模型 select + 阈值 + 页眉页脚开关；
> `core/layout.rs`（模型池发现、`LayoutEngine` Paddle MNN 推理、`rule` 纯几何
> 检测、XY-Cut 阅读顺序、Markdown 组装，含单测）；`ocr_page` 本地分支与
> `image→md` 按 `ocrLayoutMode` 分派；IPC `list_layout_models`；`LayoutEngineCache`
> 常驻与设置变更失效；4 个版面模型目录的 `layout-meta.json` + README；中英文
> 设置 UI。各模型 `layout-meta.json` 已按随权重下载的 `config.json` 校准：
> 输入尺寸（480×480 / 800×608）、`keep_ratio`（均为拉伸）、`label_list` 类别
> 顺序；引擎按 meta 的 `keepRatio` 做拉伸/letterbox 预处理与坐标回映（含单测）。
>
> 待办：draw-a-table 列线建议增强（设计标为可拆独立 PR）；状态栏「分析版面
> N/M」阶段（需新增后端→前端进度事件）；`paddle` 档实跑对拍（.mnn 权重已就位
> 但已加入 `src-tauri/.gitignore`，不入库）。

> 本文档回答一个问题：DocCraft 的本地 OCR（`ocr-rs` 2.4 PaddleOCR）目前只有
> 「检测 → 识别」两级，缺少版面分析，应该怎么补。
>
> **结论**：
> 1. 表格切分已由 **draw-a-table 划线**（含 OCR 页块级 bbox 切列）解决，
>    本次版面分析**不解决表格结构**，只解决「多栏阅读顺序、标题层级、
>    页眉页脚/噪声过滤、表格/图片区域语义」；
> 2. 多种版面结构（双栏、跨栏、侧栏、复杂排布）是纯几何规则无法可靠
>    覆盖的，**主方案为 Paddle 官方版面检测模型**（PicoDet 系**模型池**，
>    默认 PP-DocLayout-S，可切换/可扩展），经已就绪的
>    **Paddle → MNN 转换脚本**转成 MNN 格式，与现有 det+rec 同一
>    MNN 运行时接入；
> 3. 纯几何规则降级为**可选档**（零模型体积的轻量兜底），不作为主方案；
> 4. 设置项：版面模式三档 select（**不使用（默认）/ 纯几何 / Paddle**），
>    `paddle` 档下再选具体**版面模型**（模型池按资源目录动态发现，
>    新增模型只需放入转换产物，不改代码）。

## 一、背景：现状与缺口

### 1.1 现有链路

`src-tauri/src/core/ocr.rs` 的 `LocalOcrEngine` 基于 `ocr-rs = "2.4.1"`（MNN 推理）：

- 模型只有两个：`PP-OCRv6_{tier}_det.mnn`（文本检测 DBNet）+
  `PP-OCRv6_{tier}_rec.mnn`（文本识别），位于 `resources/models/`；
  `ocr-rs` 2.4 的公开 API 仅支持 det / rec（以及方向分类），
  **不支持版面分析模型**（crates.io 文档确认其模型族仅 det/rec）。
- `recognize_image_with_confidence` 的"版面理解"是纯几何的：
  按 Y 排序 → 行内按 X 排序 → 阈值（1.5% 图高）分行 → 拼接。
- `recognize_png_blocks` 保留块级 bbox，供 draw-table 按用户画的竖线切列。

### 1.2 症状与归属（哪些已解决、哪些是本方案目标）

| 症状 | 归属 |
|------|------|
| 表格结构无法自动重建 | ✅ 已由 draw-a-table 划线解决（含 OCR 页 bbox 切列、AI 划线提示），**非本方案目标** |
| 双栏/多栏文档左右栏串行混排 | ❌ 本方案目标（主因，纯几何对不规则多栏不可靠） |
| 标题与正文无层级 | ❌ 本方案目标 |
| 页眉页脚混入正文 | ❌ 本方案目标（OCR 页缺 repeated-header 剥离） |
| 图片/印章/水印区域产生噪声文本 | ❌ 本方案目标 |
| 表格区域语义识别（自动定位表区，减少手动画线） | ◐ 顺带收益：版面模型给出 table 区域后可为画线提供初始列线建议 |

### 1.3 为什么纯几何不够（选型论证）

纯几何（XY-Cut / 列投影 / 字号聚类）能覆盖**规整双栏**，但本次要解决的
痛点恰恰是「**多种版面结构**」：

- 跨栏表格/图片会把左右栏"焊死"，列投影检测出假间隙；
- 侧栏注释、脚注与正文宽度相近，几何无法区分；
- 标题 vs 正文、图片 vs 大字号文本，几何启发式误判率不可控；
- 页眉页脚要靠跨页重复匹配，OCR 页的 bbox 抖动让匹配不稳定。

结论：**纯几何只作为无模型时的可选兜底（rule 档），主方案必须是版面检测模型。**
模型选型见 3.2——Paddle 官方 PicoDet 系轻量模型池总体积仅 ~25MB（fp32），
与「本地优先、轻量分发」的产品约束完全兼容。

## 二、目标与非目标

**目标**

1. 本地 OCR 输出恢复**阅读顺序**：多栏、双栏、跨栏元素不串行；
2. OCR 页产出**结构化 Markdown**：标题分级、段落、图片占位；
3. 页眉/页脚/水印区域可过滤；
4. table 区域检测可作为 draw-a-table 的**列线建议**输入（顺带收益，不替换划线）；
5. 保持现有架构约束：纯本地（不出网）、CPU 可跑、引擎常驻、
   OcrMode 五档语义不变、与 draw-table / image→md / snip 共享引擎缓存。

**非目标**

- 表格结构自动重建（SLANeXt / 单元格检测等）——划线已覆盖，后续单独立项；
- 公式识别（LaTeX）、版面恢复为 docx；
- 替换远程 AI vision 模式——`forceAi` 整页交给模型，天然带版面语义。

## 三、方案选型

### 3.1 设置项：版面模式三档 + 模型选择

`app-settings.json` 新增 `ocrLayoutMode`，Settings「OCR 服务」区一个 select：

| 档位 | 值 | 行为 |
|------|----|------|
| 不使用版面分析（**默认**） | `"off"` | 现状行为：纯 Y→X 排序拼行，输出与今天完全一致 |
| 纯几何 | `"rule"` | XY-Cut 列检测 + 标题字号启发式 + 页眉页脚条带过滤（零模型依赖） |
| Paddle 模型 | `"paddle"` | 模型池中选定模型的 MNN 推理 + 区域分类 + 阅读顺序重组 |

`paddle` 档下追加**版面模型 select**（`ocrLayoutModel`）：选项由
`resources/models/layout/` 目录动态发现（每个子目录 = 一个模型，
含 `.mnn` + `layout-meta.json`），首期为 3.2 表中的 4 个模型，默认
`PP-DocLayout-S`；后续新增模型放入转换产物即自动出现在下拉中。

默认 `off` 保证零回归风险；用户在多版面扫描件上遇到串行问题时手动切换。

### 3.2 模型池：Paddle 官方版面检测模型（多模型可切换）

版面模型做成**可选池**而非单一选定：各模型在类别粒度、精度、训练域上
各有侧重，用户按文档类型选择；后续新模型只需走同一转换流程放入资源
目录即可扩展，不改代码。

首期纳入 4 个模型（PaddleOCR 官方模型库轻量档）：

| 模型 | 骨干 | 体积 | mAP@0.5 | CPU 耗时（常规/高性能） | 类别 | 适用场景 |
|------|------|------|---------|--------------------------|------|----------|
| **PP-DocLayout-S（默认）** | PicoDet-S | **4.8MB** | 70.9% | 18.5 / 6.3 ms | 23 类（中英文论文/研报/试卷/书籍/杂志/合同/报纸） | 训练域最广，通用文档默认选择 |
| PicoDet-S_layout_17cls | PicoDet-S | 4.8MB | 87.4% | 17.5 / 6.4 ms | 17 类（段落标题/图片/文本/数字/摘要/内容/图表标题/公式/表格/表格标题/参考文献/文档标题/脚注/页眉/算法/页脚/印章） | 论文/研报类，同体积精度更高 |
| PicoDet_layout_1x | PicoDet-1x | 7.4MB | 97.8% | 27.0 / 12.8 ms | 5 类（PubLayNet：文字/标题/表格/图片/列表） | 类别少而准，版面规整的通用文档 |
| PicoDet_layout_1x_table | PicoDet-1x | 7.4MB | 97.5% | 27.7 / 16.8 ms | 1 类（仅表格） | 专用于 table 区域检测 / draw-a-table 列线建议增强 |

> 后续可扩展：PP-DocLayout-M（22.6MB，23 类）、PicoDet-L_layout_17cls
> （22.6MB）等均走同一接入路径，仅资源体积增量。

**默认 PP-DocLayout-S**，理由：

- **体积 4.8MB**：转换 MNN（fp16）后更小，**直接随安装包捆绑**，
  无需下载流程、无新原生依赖（4 个模型全量捆绑也仅 ~25MB fp32）；
- CPU 推理 6–19ms/页，版面开销相对 det+rec 的数百毫秒可忽略；
- 23 类覆盖阅读顺序所需的全部语义（text / paragraph_title / doc_title /
  table / figure / chart / page_header / page_footer / seal 等）；
- 与现有 PP-OCRv6 det/rec 同为 Paddle 系，**Paddle→MNN 转换脚本已就绪**
  （本仓库已有 Paddle 推理模型转 MNN 的工具链），转换口径统一。

**模型间差异的处理**：不同模型的类别数不同（1 / 5 / 17 / 23 类），
统一由各模型自带的 `layout-meta.json` 声明类别表并映射到内部
`LayoutClass` 处理桶（Title / Text / Table / Figure / Header / Footer /
Seal / Other）——**类别不落在任何桶里的归入 Other，按正文处理**，
因此模型切换对管线代码透明；仅有 1 类的 `1x_table` 缺少标题/页眉语义，
其输出仅用于 table 相关增强（见 3.4），不承担阅读顺序职责。

### 3.3 推理承载：复用 `ocr-rs` 公开的低层 MNN API（已验证可行）

`ocr-rs` 2.4 虽未提供版面模型封装，但**公开导出了底层能力**
（docs.rs 确认 Re-exports 与模块结构）：

- `ocr_rs::mnn` —— MNN 推理引擎的 FFI 绑定层（公开模块）；
- `ocr_rs::InferenceEngine` / `InferenceConfig` —— 低层推理引擎，
  可从文件路径或内存 bytes 加载**任意 `.mnn` 模型**并执行推理；
- `ocr_rs::preprocess` —— 归一化 / 缩放等预处理工具；
- `ocr_rs::postprocess` —— NMS / 框合并 / 排序等后处理工具
  （PicoDet 后处理可直接复用）。

因此版面引擎的接入方式是：**在 `core/layout.rs` 用 `ocr_rs` 的低层
API 自建 `LayoutEngine`**，不新增任何推理依赖：

- `LayoutEngine` 通过 `InferenceEngine`（`mnn` 绑定）加载选定模型的
  `model.mnn`，与 det/rec 共享同一 MNN 运行时与动态库——
  **零新增原生依赖、零第二推理引擎**；
- 前后处理组合：
  预处理 = resize 到模型输入尺寸（meta 声明，如 800×1330 或动态
  shape）+ 归一化（mean/std 按 PaddleX 配置）+ NCHW，可复用
  `preprocess` 工具或自写（PicoDet 输入输出格式明确）；
  后处理 = 解码 bbox + score + class → NMS（复用 `postprocess`）→
  映射回原图坐标；
- **多模型差异全部收在 meta**：输入尺寸 / 归一化参数 / 类别表 /
  类别 → `LayoutClass` 桶的映射，均由各模型目录的
  `layout-meta.json` 声明，`LayoutEngine` 按 meta 驱动，模型切换
  与新增不改引擎代码；
- 与 det/rec 引擎相同地应用 `local_ocr_threads` 线程数与
  fp16 精度设置（转换脚本默认 fp16，与 OCR 模型口径一致）；
- 若实现中发现 `InferenceEngine` 对版面模型的输出张量访问有缺口
  （如动态 shape 会话配置），退路是直接依赖 `mnn` crate——但它是
  ocr-rs 同一 MNN 绑定的上游形式，仍不构成第二运行时。

### 3.4 管线（`paddle` 档，每 OCR 页一次）

```
页面 PNG
  → LayoutEngine.detect()             [MNN，当前选定模型，~10–20ms/页]
  → regions: {class, bbox, score}（XY-Cut 阅读顺序排序）
  → 按区域裁剪 → LocalOcrEngine.recognize_image_with_confidence(裁剪图)
      ├─ doc_title / paragraph_title → Markdown 标题（按区域高度分桶定级别）
      ├─ text / abstract / content   → 段落（复用 paragraph 模式逻辑）
      ├─ table                       → 不自动重建结构：
      │     输出区域文本行 + 提示「建议画线提取」；区域 bbox 作为
      │     draw-a-table 列线建议的初始参考（跨页记忆最近一次区域）
      ├─ figure / chart              → `![figure](占位)` 或跳过（可配置）
      ├─ page_header / page_footer   → 丢弃（或折叠为注释，可配置）
      ├─ seal / noise 类             → 丢弃
      └─ footnote / reference 等     → 归为正文小字段落
  → 区域间插入空行，保持 `<!-- Page N -->` 标记链路不变
```

细节：

- 模型漏检的文本块（不在任何 region 内）按几何顺序回填到最近区域之后，
  保证**不丢字**；
- 裁剪区域 bbox 外扩 8px 防止切字；高度 <20px 的区域跳过；
- 标题级别映射：doc_title → `#`，paragraph_title 按高度分桶 → `##`/`###`；
- 置信度链路不动：`ocr_confidence` 仍只统计 OCR 块，版面 score 不混入。

### 3.5 纯几何档（`rule`）的收敛范围

不再承担表格/复杂版面职责，只做三件事：

1. **列检测**：X 投影找列间隙 → 规整双栏拆分（列宽 <15% 页宽不拆；
   检测到疑似跨栏元素时放弃拆分）；
2. **标题启发式**：行高 ≥ 页内中位行高 1.4× 且较短 → 标题；
3. **页眉页脚条带**：顶/底 8% 条带内文本默认丢弃（不做跨页匹配，
   简化为可解释的规则）。

定位：不想改变默认输出、又需要基本分栏修复的中间档；
`paddle` 档体验全面优于 `rule` 后可考虑远期移除。

## 四、实施方案

### 阶段一：Paddle 模型接入（主路径）

**模型与转换**

1. 用现有 Paddle→MNN 转换脚本逐个产出首期 4 个模型，资源目录结构
   （每模型一个子目录，meta 驱动发现）：

   ```
   resources/models/layout/
   ├─ PP-DocLayout-S/
   │  ├─ model.mnn                  （fp16）
   │  └─ layout-meta.json           （输入 shape / 归一化 / 类别表 / 桶映射 / 显示名）
   ├─ PicoDet-S_layout_17cls/
   ├─ PicoDet_layout_1x/
   └─ PicoDet_layout_1x_table/
   ```

   转换时记录输入 shape / 归一化参数 / 类别表到各 `layout-meta.json`
   （后处理读取；**后续新增模型只需新加一个子目录**，模型 select
   自动出现该选项，不改代码）；
2. 验证：与 PaddleX Python 推理结果对拍同一批页面图（bbox IoU > 0.95，
   类别一致），确认各模型转换均无精度损失。

**后端**

3. `core/layout.rs` 新增：
   - `layout_models_dir()`：扫描 `resources/models/layout/` 的子目录，
     读取 meta 返回可用模型清单（供 IPC 下发给设置页）；
   - `LayoutEngine::new(model_dir, threads)`：经
     `ocr_rs::InferenceEngine`（`mnn` 绑定）加载模型 session +
     预处理 / 后处理（NMS、坐标映射、类别解码 → `LayoutClass` 桶）；
   - `detect(png) -> Vec<LayoutRegion>`，`LayoutRegion { class, rect,
     score }`；
   - 阅读顺序：XY-Cut 排序（与 `grid_rebuild` 几何代码风格一致）；
   - 引擎常驻：仿照 `OcrEngineCache` cell 写法
     （`Arc<Mutex<LayoutEngine>>`，仅 `paddle` 档懒加载；按选定的
     模型缓存，切换模型时释放旧实例重建；模型 ~5–7MB，常驻内存可接受；
     **snip 截图路径不加载**——小图无版面需求）；
   - 模型/元数据缺失、或设置选定的模型不存在时降级到 `rule` 档行为
     并记一条通知（bell），不报错；
   - **实施前置**：先写一个最小验证（用 `ocr_rs::InferenceEngine`
     加载 `PP-DocLayout-S.mnn` 对一张页面图跑通推理并解出 bbox），
     确认低层 API 的会话配置 / 输出张量访问满足 PicoDet 后处理
     需要，再进入完整实现；
4. `ocr_page` 本地分支改造：按 `ocrLayoutMode` 分派
   `off / rule / paddle` 三路；`paddle` 路按 3.4 管线组装 Markdown
   （引擎取 `ocrLayoutModel` 选定的模型）；
5. draw-a-table 增强（顺带收益，可拆为独立 PR）：`extract_draw_table`
   的 OCR 页路径先跑 `LayoutEngine` 拿 table 区域，把区域左右边界
   转成初始列线建议展示在面板上，用户确认/调整后进入现有切列流程；
   仅关心 table 区域时可在该路径单独使用 `PicoDet_layout_1x_table`
   （1 类专用模型），不受全局 `ocrLayoutModel` 约束。

**设置与 UI**

6. `AppSettings` 增加：
   - `ocr_layout_mode`: `"off" | "rule" | "paddle"`（默认 `"off"`）；
   - `ocr_layout_model`: String（默认 `"PP-DocLayout-S"`；值 = 资源
     目录中的模型子目录名，后端校验存在性，失效时降级并通知）；
   - `layout_score_threshold`: 0.5（PicoDet 推荐）；
   - `layout_drop_header_footer`: bool（默认 true，`paddle` 档生效）；
7. 新增 IPC `list_layout_models`（扫描资源目录返回模型清单：
   目录名 / 显示名 / 类别数 / 桶能力标记，供设置页渲染下拉）；
   Settings「OCR 服务」区新增"版面分析"行（Soft Rows 风格）三档
   select + 模型 select + 子选项（阈值 / 页眉页脚开关随 `paddle` 档
   展开），i18n 双语词条；状态栏活动指示增加「分析版面 N/M」阶段。

**分发**

8. 4 个模型全量 fp32 ~25MB（fp16 后 ~12–15MB）**直接随包捆绑**，
   与现有 OCR MNN 模型同一目录约定，无下载流程、无新原生依赖；
   后续模型若体积较大（如 PP-DocLayout-M）可只提供转换产物说明
   而不默认捆绑，仍按目录发现机制接入。

### 阶段二：纯几何档（`rule`，可与阶段一并行或其后）

9. `core/layout.rs` 内实现 3.5 的三条规则（纯函数 + 单测），
   复用 `recognize_png_blocks` 的块级 bbox；
10. 设置 select 三档贯通，`rule` 档默认行为即 3.5 全开。

### 阶段三（远期，另行立项）

- 模型池扩充：PP-DocLayout-M / PicoDet-L_layout_17cls 等高精度档
  （目录发现机制天然支持，仅体积取舍）；
- table 区域 → SLANeXt 表格结构自动重建（减少画线依赖）；
- 公式区域占位 / 公式识别。

## 五、风险与缓解

| 风险 | 缓解 |
|------|------|
| `ocr-rs` 低层 `InferenceEngine`/`mnn` 模块对版面模型的输出张量访问有缺口（如动态 shape 会话配置、输出解码） | 先做最小 demo（用 `ocr_rs::InferenceEngine` 加载 layout.mnn 跑通一次推理）验证；退路是直接依赖 `mnn` crate（ocr-rs 同一 MNN 绑定的上游形式，仍不构成第二运行时），该退路已并入 3.3 |
| Paddle→MNN 转换对 PicoDet 算子支持不全 / 精度损失 | 转换脚本已就绪（OCR det/rec 已验证）；阶段一步骤 2 与 PaddleX 对拍把关；单模型转换失败不影响其余模型，缺的从池中剔除即可 |
| 各模型类别表不同（1 / 5 / 17 / 23 类），后处理分叉 | 类别 → `LayoutClass` 桶映射收在各模型 meta 中，引擎统一按桶处理；未映射类别归 Other 按正文处理 |
| 默认 PP-DocLayout-S mAP 70.9% 低于 17cls | 模型池可切换：对拍阶段同时评 4 个模型，按文档类型在文档中给出选型建议；切换零代码（meta 驱动） |
| 标题级别映射不准（模型只给 title 类） | doc_title 固定 `#`；paragraph_title 按高度分桶 + 全文档统计；V1 接受不完美（现状是无层级） |
| 多栏误切 / 漏检丢字 | 漏检块回填机制（3.4）保证不丢字；`off` 为默认档，用户显式选择才改变输出 |
| 版面模型误检导致内容丢失（如把正文判为 header） | `layout_drop_header_footer` 可关；被丢弃区域以 HTML 注释保留摘要（`<!-- 已过滤页眉: ... -->`），可追溯 |
| 每页新增 ~10–20ms + 懒加载首次 ~0.3s | 相对 det+rec 数百毫秒占比极小；引擎常驻消除重复加载 |

## 六、验收清单

- [ ] 转换对拍：4 个模型的 .mnn 与 PaddleX 输出 bbox IoU > 0.95、类别一致
      （待模型转换产物，`LayoutEngine::detect` 已按 [class, score, x1,y1,x2,y2]
      解码就位）；
- [x] 低层 API 可行性：`ocr_rs::InferenceEngine` 已接入 `LayoutEngine`
      （`core/layout.rs`，`mnn` 绑定 + `run_dynamic`），构建与打包无新增原生
      依赖（仅将 ndarray 提升为直接依赖，本就是 ocr-rs 的传递依赖）；
- [ ] `paddle` 档（默认模型 PP-DocLayout-S）：双栏扫描件按「左栏→右栏」
      输出；标题分级；页眉页脚过滤；图片区域不产生噪声文本；
      `<!-- Page N -->` 链路不变（待 .mnn 捆绑后实跑验证）；
- [ ] 模型切换：切换到 17cls / 1x / 1x_table 各跑同一样本，管线无
      报错、类别差异正确收敛到 `LayoutClass` 桶（待模型转换产物）；
- [x] 扩展性：`list_layout_models` 按 `resources/models/layout/` 子目录动态
      发现（meta 解析即列出、有 .mnn 即 available），新增目录即自动出现在
      模型 select；
- [x] 漏检文本回填：`assemble_markdown` 对未落入任何区域的块按几何顺序回填
      （含单测 `assemble_backfills_unassigned_blocks`）；
- [x] `off` 档输出与改动前逐字节一致（`recognize_bytes_with_layout` 的 off
      分支走原 `recognize_bytes_with_confidence` 路径，默认零回归）；
- [x] `rule` 档：规整双栏拆分正确、跨栏元素不拆、标题分桶、页眉页脚条带
      过滤（含单测 `rule_detect_*` 系列）；
- [x] 模型文件缺失时 `paddle` 档降级为 `rule` 行为 + stderr 通知，无 panic
      （`recognize_bytes_with_layout` 的 Paddle 分支）；
- [x] `forceAi` / `disabled` 模式行为不变；snip 路径不加载版面模型
      （snip 走 `acquire_snip_ocr_engine` 原路径，不触碰 LayoutEngineCache）；
- [x] `pnpm exec tsc --noEmit`、`cargo check`、`cargo test --lib`（121 项）
      全绿；
- [ ] 安装包体积增量 ≈ 4 个模型总大小（fp16 后 ~12–15MB），无新增原生依赖
      （待 .mnn 捆绑）。

## 七、参考

- PaddleOCR 官方模型库（PP-DocLayout-L/M/S 23 类、PicoDet layout 系、
  体积 / mAP / CPU 耗数据）：PaddleOCR 2.10 Release Notes 与
  PP-ChatOCRv4 产线模型列表
- ocr-rs 2.4.1 模型支持范围（仅 det/rec/cls）：crates.io/crates/ocr-rs
- 本项目：Paddle 推理模型 → MNN 转换脚本（已就绪，det/rec 已用其产出
  `resources/models/*.mnn`）
- [00005_snip-local-ocr-latency.md](./00005_snip-local-ocr-latency.md)
  （引擎缓存/线程/精度调优模式，LayoutEngine 直接仿照）
- [00011_draw-line-exclude-region.md](./00011_draw-line-exclude-region.md)、
  [00015_guided-paragraph-mode.md](./00015_guided-paragraph-mode.md)
  （划线表格与段落合并的现状，本方案在其上游插入版面阶段）
