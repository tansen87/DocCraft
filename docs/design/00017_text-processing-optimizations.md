# 文本处理优化(Text Processing Optimizations)设计方案

状态:**提案**(proposal,未实施,2026-09-02)
范围:PDF → Markdown / OCR → Markdown / Markdown → Excel 三条文本处理链路的
正确性、输出质量与性能优化。不含 UI / 性能(渲染)类议题。
关联:`src-tauri/src/core/{paragraph,layout,grid_rebuild,md_to_xlsx,page_marker,ocr,convert}.rs`、
`docs/design/00013_pdf-line-break-mode.md`(段落模式)、
`docs/design/00015_guided-paragraph-mode.md`、
`docs/design/00016_local-ocr-layout-analysis.md`

---

## 0. 一句话结论

当前文本处理链路的**结构性骨架**(通道划分、段落策略、版面分析、页标记)已经稳定,
遗留的问题集中在**后处理细节**:`md_to_xlsx` 解析器不感知代码围栏、文本启发式的
句末判定过宽、CJK 列切分只认半角空格、每对相邻行重复计算中位数等。本方案汇总为
**11 个优化点,按 P0(正确性)→ P1(质量)→ P2(增强)分级**,P0 全部是
小改动、可独立验收,不动任何数据结构或 IPC 契约。

---

## 1. 现状与代码坐标

三条链路最终都汇入同一段后处理:

```
通道 A(OCR 页:本地 PaddleOCR / 远端 AI)
  ocr.rs  local_ocr_page (:1016) / ocr_page_in_session (:941)
    → paragraph::apply_text(ocr.rs:996 / :1035)   ← 文本启发式,无几何
通道 B(文本层页)
  grid_rebuild::rebuild_pages (:64)
    group_lines_with_meta (:256)  按 y 聚视觉行
    group_cells_with_meta (:313)  行内 split_at_column_gaps (:434) 按双空格切列
    lines_to_markdown_with_meta (:352)  行间 "\n"
  → paragraph::apply(convert.rs:108 / ocr.rs:854) ← 几何启发式(G1–G9)
通道 C(Markdown → Excel)
  md_to_xlsx::parse_md_blocks (:58)  →  write_table (:142)
```

段落策略详见 `00013`;`apply_text` 的文本启发式 `hard_break_textual`
(paragraph.rs:237)同时服务 OCR 页与截图识别(snip.rs:352/:373)。

---

## 2. 问题清单

### P0-1 `md_to_xlsx` 解析器不跟踪代码围栏,代码块中的表格样例会被误提取

- **现象**:`.md` 文件代码块里演示 GFM 表格语法的样例(文档、教程类文件极常见),
  会被 `parse_md_tables` 当作真表格导出到 Excel,污染数据。
- **根因**:`parse_md_blocks`(md_to_xlsx.rs:58-104)逐行扫描时没有任何
  fence 状态;而同仓库的 `paragraph::join_page`(paragraph.rs:121-129)已经
  正确实现了 fence 开关。两个解析器行为不一致。
- **方案**:在 `parse_md_blocks` 的循环中引入与 paragraph.rs 相同的
  `is_fence_marker` 开关,围栏内的行一律按 `MdBlock::Line` 处理。
- **验收**:新增单测——代码块内的 `| A | B |` + `|---|---|` 样例不出现在
  `parse_md_tables` 结果中;围栏外紧邻的真表格仍正常提取。

### P0-2 `ends_sentence` 把闭合括号/引号/撇号当句末标点,误断段

- **现象**:OCR 正文里以 `)`、`]`、`}`、`"`、`'`、`》` 结尾的行
  (如 "(详见附录一)"、人名 "J. Smith's")被 `hard_break_textual` 的 T1
  判为段落结束,smart 模式下错误保留换行;`'` 还会让英文所有格结尾的行
  全部免于合并。
- **根因**:paragraph.rs:458-486 的 `ends_sentence` 匹配表把引号、撇号、
  各类闭合括号与句号并列。句号类(`.` `。` `!` `?` `…` `;` `;` `!` `?`)
  是强边界,括号/引号只是**可能的**边界。
- **方案**:
  1. 从 `ends_sentence` 中移除 `'` `"` `”` `’` `)` `）` `]` `}` `】` `>`;
  2. 保留 `」` `』`(日式引号在中文文本里几乎总是句子结束,维持现状);
  3. 如仍需括号边界,仅当**整行以开括号配对闭合**(行内括号平衡)时才算句末,
     作为后续增强而非首期实现。
- **验收**:更新单测:以 `)` / `'` 结尾的相邻行在 smart 模式下被合并;
  以 `。` / `.` 结尾的行为不变。

### P0-3 `split_at_column_gaps` 只识别半角双空格,CJK 列内容不被切分

- **现象**:中文 PDF(用全角空格或全角逗号+空格分列)的 borderless 表格行
  整行不切列,`textSeparator` 无从插入,后续 smart 模式还会把这些列粘成一句。
- **根因**:grid_rebuild.rs:434-458 按字节 `b' '` 匹配,U+3000(全角空格,
  UTF-8 三字节)永远不命中;`it.text.trim()` 只能去掉首尾。
- **方案**:`split_at_column_gaps` 改为按 `char` 遍历,把
  **"2 个及以上连续空白字符(含 U+3000 / U+00A0)"** 视为列间隙;
  单元格内部的单个空格/全角空格语义不变。
- **验收**:单测——`"姓名　　年龄　　部门"`(全角空格)切出 3 列;
  `"hello world"` 仍不切。

### P0-4 `median_line_len` 在每对相邻行上重复计算,O(n² log n)

- **现象**:OCR 大页(数百上千行)走 `hard_break_textual` 时,
  每处理一行都对整页行长做一次排序取中位数;截图识别同样命中。
- **根因**:`join_page`(paragraph.rs:153)把整页 `&lines` 传进
  `hard_break_textual`,而中位数在函数体内(paragraph.rs:257)每次重算。
- **方案**:`join_page` 进入循环前调用一次 `median_line_len`,
  作为参数传入 `hard_break_textual`(与 `geom` 同样的预计算模式)。
  复杂度从 O(n² log n) 降为 O(n log n)。
- **验收**:现有全部段落单测通过(行为不变);
  可加一条 1000 行基准,断言耗时量级下降(可选)。

### P0-5 `starts_block_marker` 的字母列表判定 `A.` 无后缀约束

- **现象**:以大写字母+句点开头的普通行——"U.S. policy on …"、
  "J. Smith 签署的 …"——被当作字母列表项(G5/T3),smart 模式误保留换行。
- **根因**:paragraph.rs:448-453 只检查 `first.is_ascii_alphabetic()`
  且下一字符是 `.`,未要求后面跟空白。
- **方案**:要求 `A.` 之后紧跟空格(单字母 + `.` + 空白)才视为列表标记;
  数字列表 `1.` 分支同样补上空白约束(`1.1` 版本号开头行目前会被误判为条款,
  见 paragraph.rs:410-414 注释里已列 `1.1`,建议收紧为"数字串 + `.` + 空白")。
- **验收**:单测——"U.S. policy" 行可被合并;"A. first item" 仍是块标记;
  "1.1 背景" 不再被误判(与 "1. 条款" 区分)。

### P1-1 OCR 输出通用清理(可选设置 `ocrTextCleanup`,默认开)

- **现象**:本地 OCR 原始输出中常见:半角/全角空格混用、行内连续空白、
  零宽字符(U+200B)、CJK 与拉丁字符之间缺空格或多余空格;
  这些噪声直接进入 markdown 与后续 Excel 导出。
- **方案**:在 `paragraph::apply_text` 之前加一个纯函数
  `clean_ocr_text(&str) -> &str / String`(建议落在 `paragraph.rs` 或新模块
  `text_clean.rs`),三条 OCR 入口(local_ocr_page / ocr_page_in_session 的
  AI 分支 / screenshot_ocr)统一调用:
  1. 移除零宽字符与 BOM;
  2. 行内连续空白(含全角空格)压缩为单个空格;
  3. CJK ↔ 拉丁/数字之间规整为恰好一个空格(与现有 `connector` 规则对齐,
     但作用于行内而非仅行间拼接);
  4. 不改标点全半角(涉及语义,列为后续讨论)。
- **设置**:`app-settings.json` 增加 `ocrTextCleanup`(默认 `true`),
  Settings → 界面调节 组内加开关。
- **验收**:单测覆盖 1–3;关闭开关时输出与现状逐字节一致。

### P1-2 Excel 导出不剥离行内 Markdown 语法

- **现象**:`**加粗**`、`` `代码` ``、`[链接](https://…)` 原样写进单元格,
  表格数据下游可用性差。
- **方案**:`write_table` 与全文导出的 `MdBlock::Line` 写入前过一遍
  `strip_inline_markdown(&str) -> String`:去 `**`/`__`/`*`/`` ` `` 强调标记,
  `[text](url)` → `text`(保留链接文字),`<br>` → 换行。
- **设置**:`app-settings.json` 增加 `stripMdSyntax`(默认 `false`),
  Settings → Excel导出 组内加开关。
- **验收**:单测覆盖强调 / 链接 / 行内代码三种;纯文本单元格不变。

### P1-3 Excel 数字/日期单元格全部按字符串写入

- **现象**:`write_string_with_format` 使所有数字以文本形式存储,
  Excel 中无法求和、排序、筛选。
- **方案**:`write_table` 中对每个单元格嗅探:纯整数 / 十进制数 /
  百分比 → `write_number_with_format`(数字右对齐格式);
  其余保持字符串。日期格式涉及本地化,首期不做。
- **设置**:`app-settings.json` 增加 `writeStringFormat`(默认 `true`),
  Settings → Excel导出 组内加开关。
- **验收**:单测——`"123"`/`"3.14"`/`"12%"` 单元格在 openpyxl/
  rust_xlsxwriter 读回时是数值类型;`"0012"`(前导零)保持文本。

### P1-4 页面级几何启发式的数值证据(G1/G3)对 OCR 页缺失的补偿

- **现象**:`hard_break_textual` 的 T4(短行=标题)只看字符数,
  OCR 结果里表格行、缩进短句都会被当标题断开;
  而 `hard_break_geometric` 有更可靠的 G1(段距)/G3(右缘不齐)信号。
- **方案**:`recognize_image_with_confidence` 已经按 y 聚行了
  (ocr.rs:98-132),把每行的 `top`/`height` 保留下来构造轻量
  `LineMeta`(x0/x1 用行内块的最左/最右),让本地 OCR 页也走
  `hard_break_geometric`——这正是 00013 §设计里"OCR 页无几何"假设的修正,
  数据已在手上,只是被丢弃了。
- **风险**:阈值(y 轴为图像像素、自上而下)与 PDF 用户空间(自下而上)相反,
  需在构造时统一;`is_local()` 与 AI 分支行为会不一致(AI 无块坐标),
  需在文档中明确"AI 输出信任模型 + textual 兜底"的现状。
- **验收**:本地 OCR 单测——两段之间有明显行距差时 smart 正确断段;
  现有 textual 单测(无 meta 路径)不变。

### P2-1 跨页重复页眉/页脚检测(文本层 + OCR 通用)

- **现象**:文本层通道靠 pdf-inspector 的重复表头/表脚剥离,
  rule 版面模式按顶部/底部 8% band 过滤;但**不在 band 内的 running header
  (如紧贴正文顶端的章节名)与 `off` 模式 OCR 页**没有清理,
  每页残留 "第 3 章 文本处理 … 12" 之类噪声行。
- **方案**:新增纯函数 `detect_running_headers(pages: &[String], min_repeat: usize)`,
  对每页首行/末行(容忍 N% 编辑距离,如忽略页码数字)在 ≥ `min_repeat`
  (建议 3)页重复时标记;`paragraph::apply` 之后统一删除或替换为注释
  `<!-- 已去除页眉: … -->`(与 layout.rs:955 的审计风格一致)。
  挂在 Settings 的版面分析组,作为独立开关 `stripRepeatedHeaders`(默认关)。
- **验收**:构造 5 页样张,首行 "第 1 章 … / 第 2 章 …" 变化但
  尾部页码一致 → 正确识别;正文首行恰好相同的边界情况不误删
  (要求重复次数阈值)。

### P2-2 AI OCR 结果与段落模式的双重处理语义澄清

- **现象**:AI 分支在 ocr.rs:996 对模型输出再跑一次 `apply_text`。
  模型已按 prompt(ocr.rs:20)合并段内折行,二次 textual 启发式
  可能把模型的长行输出(无折行)再按 T1/T4 切开,输出劣化。
- **方案**(二选一,建议 a):
  a. 维持现状,但在 00013 与本文档记录"AI 输出 = 模型结构 + textual 兜底"
     的语义,并把 P0-2/P0-5 的收窄作为主要止血手段;
  b. AI 分支仅在 `ParagraphMode::None` 时强制合并,Smart/Guided 直接透传。
  b 会改变现有输出,需灰度;首期选 a。
- **验收**:无代码变更(a)或快照测试对比(b)。

### P2-3 杂项性能与代码卫生

| 项 | 位置 | 改法 |
| --- | --- | --- |
| `pages_with_tables.contains` 线性扫描 | paragraph.rs:49 | 调用侧转 `HashSet`(页数多时) |
| `is_table_page` 每模式重复计算 | paragraph.rs:99 | `apply` 里算一次随 meta 传入(可选) |
| OCR_PROMPT 固定中文 | ocr.rs:20 | 增加英文默认模板,按文档主语言或用户语言选择(低优先) |

---

## 3. 实施顺序建议

| 批次 | 内容 | 预估工作量 | 依赖 |
| --- | --- | --- | --- |
| 第一批(止血) | P0-1 ~ P0-5 | 每个 0.5 天内,合计 ~2 天 | 无,全部独立可测 |
| 第二批(质量) | P1-1 / P1-2 / P1-3 | ~2 天(P1-1 含设置项与 UI 行) | P0-2 先行,避免清理后启发式行为再变 |
| 第三批(增强) | P1-4、P2-1 | ~3 天,各自独立 | P1-4 需先冻结 paragraph 行为快照 |
| 记录 | P2-2 / P2-3 | 0.5 天 | 无 |

每项都应附带:单测(行为)、以及一条"现状输出 vs 新输出"的对照样例,
P1-1/P1-4 这类改变输出的项需在 changelog 中注明迁移说明。

## 4. 风险与兼容性

1. **输出变化即用户可见变化**:P0-2/P0-5 会改变既有文档的 smart 合并结果
   (变好,但不同);需在 changelog 明示,并保留单测对照。
2. **P1-3 数字嗅探的前导零/编号列**:`0012`、`1,234.5`(千分位)、
   身份证号必须保持文本——嗅探规则要保守,只认 `^\d+(\.\d+)?$` 与
   `^\d+(\.\d+)?%$`。
3. **P1-4 坐标系翻转**:图像 y 向下、PDF y 向上,`hard_break_geometric`
   的 G1 判据 `m_prev.y - m_cur.y > line_height * 1.5` 依赖"上一行 y 更大",
   OCR 构造 `LineMeta` 时需统一翻转,否则段距判据反向。
4. **不改 IPC 契约**:本方案全部改动在 Rust 核心与一个新设置项
   (`ocrTextCleanup`、`stripRepeatedHeaders`)内,DTO 与命令签名不变,
   仅 `AppSettings` 增加两个可选字段(向后兼容,缺省即默认值)。

## 5. 验收清单(汇总)

- [ ] 代码围栏内的表格样例不进入 Excel 导出(P0-1)
- [ ] `)` / `'` / `"` 结尾行可被 smart 合并;`。` / `.` 行为不变(P0-2)
- [ ] 全角空格分隔的 CJK 行正确切列(P0-3)
- [ ] 1000 行 OCR 页段落处理耗时量级下降;现有单测全绿(P0-4)
- [ ] "U.S." / "J. Smith" 不再被当列表;"A. " 仍是标记(P0-5)
- [ ] `ocrTextCleanup` 开关生效,关闭时输出逐字节一致(P1-1)
- [ ] Excel 单元格无 `**` / `[]()` / 反引号残留(P1-2)
- [ ] 数值单元格在 Excel 中为数字类型;前导零保持文本(P1-3)
- [ ] 本地 OCR 页利用行几何正确断段;AI 分支行为记录在案(P1-4 / P2-2)
- [ ] 重复页眉开关生效,3 页以上重复才移除(P2-1)
- [ ] `pnpm exec tsc --noEmit` 与 `cargo test --manifest-path src-tauri/Cargo.toml` 全绿
