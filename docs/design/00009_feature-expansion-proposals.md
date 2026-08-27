# 功能扩展提案清单(Feature Expansion Proposals)

状态:待评审(P0:仅 2.3 已落地,2.1/2.2/2.4 已移除)
关联:[../index.md](../index.md)(项目结构与现状)、[00001_snip-performance.md](./00001_snip-performance.md)、[00005_snip-local-ocr-latency.md](./00005_snip-local-ocr-latency.md)(snip 性能硬约束)、[00007_ui-modernization.md](./00007_ui-modernization.md)(UI 待办)

---

## 1. 背景

本项目已完成的核心闭环:**PDF → Markdown**(混合文本 + OCR)、**Markdown → Excel**、**Image → Markdown**(OCR)、**截图识别**(全局热键)、绘制式表格提取、批量并发队列、双语 UI、配置备份/恢复。

本文从「输入端 / 提取能力 / 导出端 / 可靠性与工程性 / 系统集成」五个维度盘点剩余的功能空白,给出分级提案。原则:

- 优先复用现有链路(hybrid session / `ocr_image_to_md` / `ocr_image_table` / worker pool),零新依赖为最佳;
- 不触碰 snip 遮罩/结果窗的延迟硬约束路径(见 00001/00005);
- 每一项均可独立落地、独立验收;P2 含新依赖或新插件,需单独评审。

---

## 2. P0 — 高收益低成本(建议第一批)

### 2.1 draw-table 横向行分隔线

现状:`draw-table-panel.tsx` / `canvas-overlay.tsx` 只有 `verticalLines` 一套数据;发给后端时 `horizontalLines: []` 为固定空数组。复杂页面(多行表头、行合并)仅靠竖线无法纠正行列划分。后端 `grid_rebuild.rs` 已具备"Grid/region 重建"基础设施,只是没有输入。

方案:

1. canvas 叠加增加"行线"绘制模式(工具栏三态:竖线 / 行线 / 选择);
2. `DrawTableResult` 载荷带上真实 `horizontalLines`(百分比坐标,与竖线同构);
3. 后端有行线时先按行线切行、再按列线切列,合并成规则网格;无行线时走完全现有的切块逻辑,结果不变。

验收:多行表头页面补两条行线后行结构正确;未画行线的既有用例回归结果与当前版本逐字符一致(可用固定样张对比)。

---

## 3. P1 — 体验与可靠性补强

### 3.1 AI 视觉 Prompt 自定义

现状:`src-tauri/src/core/ocr.rs:20` 的 `OCR_PROMPT` 与 `:391` 的 `DRAW_TABLE_PROMPT` 为编译期常量,页面版式特殊(章节批注、脚注密集)时用户无法干预识别风格。

方案:`AppSettings` 增加 `aiOcrPrompt` / `drawTablePrompt`(空 = 默认常量),HTTP 请求组装时替换;设置页 OCR 服务区加两个可折叠文本域;随 `export_config` / `import_config` 自然迁移。

验收:填入自定义模板(如"不要合并跨页表格")后 forceAi 结果确实变化;清空字段恢复内置默认文案。

### 3.2 页码范围转换

现状:hybrid session 总是对整份 PDF 转换(`pages_needing_ocr` 全量处理);几百页文档只想取某一章时浪费时间与 token。

方案:convert 工具栏加可选"页码范围"输入(`1-5,8,12-14` 语法);前端据此裁剪待渲染 OCR 页集合,后端文本提取限页(传 range 进 session start);`<!-- Page N -->` 保持**原文档页号**,Excel 归因不受影响。

验收:输入范围后处理时间显著下降且输出只含该范围;不填范围行为与现状完全一致。

### 3.3 文件夹批量导入

现状:整窗拖放支持多文件,但不支持目录;上百个 PDF 只能多次框选。

方案:drop 收到目录时(及文件对话框启用 directory 选择)递归收集 `.pdf` / `.png|.jpg` / `.md`,按扩展名分流到对应视图的任务列表;超过阈值(如 200)先弹确认。

验收:拖入一个三类文件混杂的目录后,各视图任务数与磁盘统计一致,子目录递归正确。

### 3.4 PDF ↔ Markdown 页级对照定位

现状:split-view 双侧滚动互不联动;好在 markdown 已有 `<!-- Page N -->` 分隔与 page-chips 定位机制,映射数据是现成的。

方案:preview header 加"对照"开关——点击 markdown 某个 Page 区块滚动右侧 PDF 到该页;点击 PDF 缩略图/页面反向滚到左侧该页区块。做**按钮级跳转**,不做实时跟随(避免两侧互相触发抖动)。

验收:任一侧点击,另一侧精确落在同一页;大文档(千页)跳转 ≤300ms。

---

## 4. P2 — 较大改动(逐项单独评审)

### 4.1 Markdown 多格式导出(DOCX / HTML)

现状:导出目标是 `.md` 与 `.xlsx`(`rust_xlsxwriter`)两族。HTML 可由前端 react-markdown + 自带样式模板低成本生成;DOCX 需要引入纯 Rust 库(候选 `docx-rs`)或外部 pandoc(过重)。

建议:先落 HTML 导出(几乎零风险);DOCX 在有真实需求评估 `docx-rs` 表格还原度后再立项——涉及新依赖,本文只作占位。

### 4.2 本地使用统计

现状:各类 DTO 都带 `processingTimeMs` 但无处沉淀,用户(和开发者)看不到"本月转了多少页、OCR 占比多少"。

方案:后端本地 JSON 追加式日志(日期、文件数、页数、OCR 页数、engine=local/ai、总耗时),绝不联网上传;设置页"备份与恢复"旁新增只读统计卡片;清除缓存区提供"清空统计"。

验收:执行一轮批量+截图操作后,统计数字与实际次数、时长吻合;导出/导入配置不影响统计数据文件。

---

## 5. 落地顺序建议

| 批次 | 内容 | 理由 |
|------|------|------|
| 第 1 批 | 2.1 / 2.2 / 2.4 | 几乎全部复用现有组件与命令,改动小、体感强 |
| 第 2 批 | 2.3(横向行线) | 前后端都要动,但范围收敛在 draw-table/grid_rebuild |
| 第 3 批 | 3.1 + 3.2(settings.rs + ocr.rs 一批改) | 同一模块集中改造,共用一次设置 schema 变更 |
| 第 4 批 | 3.3 / 3.4 / 3.5 | 中等工作量,彼此独立 |
| 持续 | P2 各项 | 含新插件/新依赖与发布流水线,逐项评审立项 |
