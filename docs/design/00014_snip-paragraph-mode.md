# 截图识别换行策略(Snip Paragraph Mode)设计方案

状态:**已实施**(done,2026-08-31)  
实施说明:按本文档完成 P0——截图识别本地 OCR 与 AI Vision 两条返回路径接入 `paragraph::apply_text` 复用 `00013` 三档策略;图片表格网格模式单元格改由 `paragraph::join_fragments` 连接;新增 snip 专项单测(§7.1)。  
注:`apply_text` 复用 `00013` §4.3 文本启发式,其 T1 会把「上一行以句末标点结尾」判为硬换行,故 §7.1「中文三行一段(逐行以句号结尾)」与 §10 示例在 `smart` 下实际保持逐行——与 PDF 批量 OCR 通道行为一致(示例本身与 T1 有出入,以实现为准)。  
关联:`docs/design/00013_pdf-line-break-mode.md`(PDF 文本层与批量 OCR 的换行策略)、  
`src-tauri/src/core/{snip,ocr}.rs`、`src-tauri/src/lib.rs`

---

## 0. 一句话结论

截图识别的本地 OCR 与 AI Vision 两条路径**均未接入 `paragraph_mode`**，导致截图结果逐视觉行硬换行，与 PDF 批量转换行为不一致。  
修复方式：在 `snip.rs` 的两个 OCR 返回路径上各加一行 `paragraph::apply_text()`，复用 `00013` 已有的三档策略，零架构变更。

---

## 1. 需求

用户对同一份 PDF 截取一页做截图识别，与对该页做批量转换，期望得到**换行行为一致**的 Markdown 输出。  
目前两条路径的输出差异显著：

```
原文(一个自然段,排版折了 3 行):
  本文档规定了XX系统的接口规范,适用于所有接入方。
  接入方应当在调用前完成鉴权,并妥善保管密钥。
  未按要求调用导致的损失由接入方自行承担。

PDF 批量转换(smart 模式):
  本文档规定了XX系统的接口规范,适用于所有接入方。接入方应当在调用前完成鉴权,并妥善保管密钥。未按要求调用导致的损失由接入方自行承担。

截图识别(现状,始终逐行):
  本文档规定了XX系统的接口规范,适用于所有接入方。
  接入方应当在调用前完成鉴权,并妥善保管密钥。
  未按要求调用导致的损失由接入方自行承担。
```

用户在设置里切到「智能合并」后期望所有输出通道行为一致，截图识别是唯一遗漏的通道。

---

## 2. 现状：哪些路径缺少段落合并

沿用 `00013` §2 的通道划分，截图识别有**三条** OCR 路径，全部在 `core/snip.rs`：

| 路径 | 入口函数 | OCR 方式 | 是否调用 `paragraph::apply_text()` |
| --- | --- | --- | --- |
| 区域截图 — 本地 | `screenshot_ocr` L322-347 | `acquire_snip_ocr_engine` → `recognize_image_with_confidence` | **否** |
| 区域截图 — AI Vision | `screenshot_ocr` L351-365 | `ai_recognize_image` + 自定义/内置 prompt | **否** |
| 图片表格 — 本地 | `ocr_image_table` L463-506 | `recognize_png_blocks` → `extract_table_from_ocr_blocks` | **否**(但见 §5) |
| 图片表格 — AI Vision | `ocr_image_table` L507-534 | `ai_recognize_table` | **否**(但见 §5) |

对比 PDF 批量通道，以下路径**已接入**：

| 路径 | 位置 |
| --- | --- |
| PDF 本地 OCR | `ocr.rs:974` `paragraph::apply_text(&text, paragraph_mode)` |
| PDF 远端 OCR | `ocr.rs:927` `paragraph::apply_text(&m, paragraph_mode)` |
| PDF 文本层转换 | `convert.rs:108` `paragraph::apply(...)` |
| 图片转 Markdown | `ocr.rs:1078` `paragraph::apply_text(&text, paragraph_mode)` |

**结论：截图识别是唯一未接入 `paragraph_mode` 的文本输出通道。**

---

## 3. 建议方案：在 OCR 返回后加一行调用

### 3.1 核心思路

截图识别是**单图识别**，没有 `LineMeta`（几何信息），只有纯文本字符串，因此只能走 `00013` §4.3 的文本启发式路径（`paragraph::apply_text`），不能走几何判定路径（`paragraph::apply`）。

`paragraph::apply_text()` 接口签名：

```rust
pub fn apply_text(text: &str, mode: ParagraphMode) -> String
```

对一段文本逐行扫描，根据文本启发式信号（T1-T6）判定段落边界，输出合并后的字符串。无几何输入时退化为纯文本判定，与 PDF 批量 OCR 通道的表现完全一致。

### 3.2 不引入新设置

`paragraph_mode` 已在 `AppSettings` 中定义并接入设置 UI（`00013` §7），截图识别直接复用该全局设置，无需新增任何配置项。用户在设置里切换档位后，所有通道（PDF 转换、批量 OCR、截图识别）立即生效。

---

## 4. 改动点：两处插入 `apply_text`

### 4.1 区域截图路径 `screenshot_ocr`

文件：`src-tauri/src/core/snip.rs`

在函数顶部读取 `paragraph_mode`，然后分别在本地 OCR 和 AI OCR 两个返回路径上施加：

```rust
pub async fn screenshot_ocr(app: &AppHandle, region: ShotRegion) -> Result<OcrImageResult, String> {
    // ... 现有代码，裁剪图片、准备数据 ...

    let paragraph_mode = crate::core::settings::get_app_settings(app)
        .map(|s| s.paragraph_mode)
        .unwrap_or_default();

    // ── 本地 OCR 路径 ──
    // 现有代码：
    //   let (text, confidence) = eng.recognize_image_with_confidence(&image, &sep)?;
    //   Ok((text.trim().to_string(), Some(confidence), save_ms))
    // 改为：
    let text = paragraph::apply_text(&text, paragraph_mode);
    Ok((text.trim().to_string(), Some(confidence), save_ms))

    // ── AI Vision 路径 ──
    // 现有代码：
    //   let markdown = crate::core::ocr::ai_recognize_image(&provider, &png_b64, &prompt).await?;
    // 改为：
    let markdown = paragraph::apply_text(&markdown, paragraph_mode);
    // ... 返回 ...
}
```

**与 PDF 批量 AI OCR 的对齐**：`ocr.rs:927` 的做法是先改 `OCR_PROMPT` 让 AI 在模型层面合并段落，再用 `apply_text` 做确定性兜底。截图识别的 AI 路径同理——内置 `effective_ai_ocr_prompt` 已包含段落合并指令（`00013` §6.4 改动后），`apply_text` 是确定性后处理，保证结果与用户选择的档位一致。

### 4.2 图片表格路径 `ocr_image_table`

表格模式输出是 **GFM 表格结构**，`paragraph::apply_text` 会破坏 `| a | b |` 格式，因此**不接入段落合并**。

但表格单元格内若有 CJK 文字折行（如 OCR 识别出 `这是一段\n说明文字` 放在同一个单元格），可用 `paragraph::join_fragments()` 连接片段，与 `00013` §4.6 划线表格的处置保持一致：

```rust
// ocr_image_table 本地路径：在组装单元格文本时
let cell_text = paragraph::join_fragments(&parts);  // 替代 parts.join(" ")
```

此改动为**可选增强**，不影响段落合并主路径，优先级低于区域截图路径（§4.1）。

---

## 5. 为什么截图识别不需要几何信号

| 维度 | PDF 文本层(通道 B) | 截图识别 |
| --- | --- | --- |
| 信息来源 | `pdf_inspector` 提供 `TextItem{y, x, font_size, ...}` | OCR 引擎只返回字符串，无坐标 |
| 行间判定主力 | `LineMeta` 几何信号 G1-G9 | 纯文本启发式 T1-T6 |
| 表格页/多栏页短路 | `pages_with_tables` / `pages_with_columns` | 不适用（单图，无页概念） |
| 输出质量 | 几何判定更精确（G1 段间距、G2 缩进） | 文本启发式依赖标点与行长统计，略逊但可接受 |

截图识别的输入是屏幕截图或单张图片，OCR 引擎的输出没有坐标信息，强行要求坐标会增加引擎适配成本（本地 PaddleOCR 有坐标但 AI Vision 不一定返回），收益有限。  
`00013` §4.3 已证明文本启发式对扫描件/OCR 输出足够可靠，截图识别复用该路径即可。

---

## 6. 前端影响与 UI 状态一致性

前端 `src/views/image-to-md.tsx` 的 `recognizeShot()` 函数（L258-345）在 OCR 返回后**不做任何文本后处理**，直接展示 `result.markdown`：

```typescript
// image-to-md.tsx:270
const result = await screenshotOcrRegion(region);
// result.markdown 直接存入状态，无二次处理
```

因此后端加 `apply_text` 后，前端自动展示合并结果，**无需改动前端代码**。

状态同步方面，`settings` 对象在 snip 触发时已加载，`paragraph_mode` 值通过 `get_app_settings` 在后端读取，与前端展示的设置选择器保持一致——用户在设置里切档后，下一次截图识别立即生效。

---

## 7. 测试计划

### 7.1 单测

在 `src-tauri/src/core/snip.rs` 的 `#[cfg(test)]` 模块中新增：

| 测试 | 输入 | 预期（smart 模式） |
| --- | --- | --- |
| 中文三行一段 | `"本文档规定了XX。\n接入方应当鉴权。\n未按要求调用。"` | `"本文档规定了XX。接入方应当鉴权。未按要求调用。"` |
| 英文软折行 | `"This document specifies\nthe interface."` | `"This document specifies the interface."` |
| 含列表结构 | `"- 项目一\n- 项目二"` | 不合并，保持原样 |
| keep 模式不变 | 同上任一输入，mode = Keep | 输出与输入字节相同 |

注意：这些是纯函数单测，直接调用 `paragraph::apply_text`，不依赖 OCR 引擎，因此不需要 mock 图片输入。

### 7.2 集成验收

| 场景 | 验证方式 |
| --- | --- |
| 截取一段中文正文 → 粘贴到编辑器 | 段落内无多余换行 |
| 截取含列表的屏幕内容 | 列表项之间保持换行 |
| 截取含表格的屏幕截图 | 表格行不被合并（G0-a 短路） |
| 切到 keep 档后截图 | 输出与改动前完全一致 |
| 切到 none 档后截图 | 非结构行全部合并为一行 |
| PDF 批量转换结果与截图识别结果对比 | 同一文档同一页，smart 模式下段落合并行为一致 |

---

## 8. 风险与边界

| 编号 | 风险 | 处置 |
| --- | --- | --- |
| R1 | `apply_text` 对极短截图（1-2 行）产生误合并 | 文本启发式要求相邻两行都非空且无结构标记才合并，1 行截图无合并对象，安全 |
| R2 | AI Vision 输出已包含 Markdown 结构（标题、列表），`apply_text` 误破坏 | `apply_text` 已跳过 `#`、`>`、`-`、`\|`、围栏等结构行（`00013` §4.3 T3/T6），与 PDF 批量 AI OCR 行为一致 |
| R3 | 截图识别结果要喂给 LLM，段落合并改变输入格式 | 合并后是更自然的段落文本，对 LLM 理解有利；`keep` 档可回退旧行为 |
| R4 | `paragraph_mode` 设置变更后，已缓存的截图结果不会更新 | 截图识别无缓存（每次重新识别），不存在 stale 缓存问题 |
| R5 | 表格模式截图接入 `apply_text` 会破坏 GFM 结构 | §4.2 已明确表格模式**不接入**段落合并，仅可选接入 `join_fragments` |

---

## 9. 实施步骤

**P0（必做）**

1. `snip.rs::screenshot_ocr` 函数顶部读取 `paragraph_mode`
2. 本地 OCR 路径（~L347）：返回前加 `paragraph::apply_text(&text, paragraph_mode)`
3. AI Vision 路径（~L365）：返回前加 `paragraph::apply_text(&markdown, paragraph_mode)`
4. `cargo test --lib` 确认无回归
5. `snip.rs::ocr_image_table` 本地路径：单元格组装时用 `paragraph::join_fragments` 替代 `parts.join(" ")`

**P1（可选增强）**

6. 新增 snip 专项单测（§7.1）

---

## 10. 附：改动前后对比

```
输入：屏幕截图，内容为一个自然段（3 行视觉折行）
设置：paragraph_mode = smart

改动前输出（截图识别）：
  本文档规定了XX系统的接口规范,适用于所有接入方。
  接入方应当在调用前完成鉴权,并妥善保管密钥。
  未按要求调用导致的损失由接入方自行承担。

改动后输出（截图识别）：
  本文档规定了XX系统的接口规范,适用于所有接入方。接入方应当在调用前完成鉴权,并妥善保管密钥。未按要求调用导致的损失由接入方自行承担。

改动前输出（PDF 批量转换 smart 模式）：
  本文档规定了XX系统的接口规范,适用于所有接入方。接入方应当在调用前完成鉴权,并妥善保管密钥。未按要求调用导致的损失由接入方自行承担。

结论：改动后两条通道输出一致 ✓
```
