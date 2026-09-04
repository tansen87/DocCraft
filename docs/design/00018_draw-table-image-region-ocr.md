# 00018 - 划线提取支持"部分照片页"(照片只占页面一部分)

- 状态: 已完成
- 日期: 2026-09-04
- 关联文档: 00011(划线 + 排除区域)

## 1. 背景与问题

用户反馈: **划线位置正确,但提取结果不按划线走;出错页的共性是该页 PDF
是一张照片,且照片只占页面的一部分(比如右侧)**.

### 1.1 现状核对

划线提取的后端路由(`line_draw.rs` `extract_tables_from_draw_lines`):

```rust
let force_ocr = ... && page_images.contains_key(&page_num);
if elements.is_empty() || force_ocr { /* OCR 回退 */ }
```

即本地 OCR 回退只在两种情况下启用:

1. **整页文本层为空**(纯扫描页);
2. **force 模式**(`forceLocal` / `forceAi`,渲染图为权威).

"照片只占页面一部分"的页两条都不满足: 照片之外的标题 / 页码 / 左侧文字
使 `elements` 非空 → 永远走文本层切分.照片区域在文本层中没有任何条目
(ocr-rs 坐标映射本身是正确的,问题出在路由判定),用户画在照片上的线
切不到任何内容,照片外的文字反而被竖线乱切 → "结果不以划线为准".

关键事实: pdf-inspector 在内容流提取时为页面内每个图片 XObject 发出
**带 bbox 的占位 item**(`ItemType::Image`,`[Image: Im0]`,坐标来自绘制
CTM),`line_draw.rs` 目前将其过滤(`to_text_elements` 只保留
Text/FormField),信息被丢弃.

### 1.2 目标

- 用户划线与页面照片区域相交时,该页以**渲染图 OCR** 为提取源(渲染图
  包含照片 + 文字的全部视觉内容,与用户画线时所见一致);
- 照片不相交的页保持文本层路径不变(不增加成本);
- 前端在未附带页面图时能获知"该页需要图",复用现有
  `emptyTextPages` 补图二调机制;
- force 模式行为不变;`disabled` 模式保持纯文本层(既有语义).

## 2. 方案设计

### 2.1 相交判定

对该页收集图片 bbox(viewport 相对坐标,减去 viewBox 原点),与用户划线
求交(ε = 1pt):

- **竖线**(全高): `[min_v, max_v]` x 区间与 `[img_x1, img_x2]` 相交;
  单线落在照片内部、或两条线把照片夹在中间(表格含照片列)均命中;
- **横线**(全宽): `[min_h, max_h]` y 区间与 `[img_y1, img_y2]` 相交;
- **矩形**: bbox 直接相交;
- 任一命中 → 该页 `needs_image_ocr = true`;面积 < 1pt² 的退化 bbox 忽略.

### 2.2 后端路由

```rust
if elements.is_empty() || force_ocr
   || (needs_image_ocr && page_images.contains_key(&page_num)) { /* OCR */ }
```

- 带图 → 渲染图 OCR 结果**替换**文本层(渲染图为该页权威,现状 local
  OCR 成功即替换的逻辑一致);
- 未带图 → 该页号记入新字段 `image_pages` 返回,前端补图后二调;
- **等待补图的页跳过文本层切分**(`continue`):照片扫描页常带隐形
  OCR 文本层(几何不可靠),若首次调用切出一表、补图后 OCR 又出一表,
  会产生重复/错误表格混入最终结果;
- 本地 OCR 失败(报错或零块)时置 `local_ocr_missed`,照片页不回退
  切分隐形文本层,保持为空并留在 `image_pages` 等重试.**不做跨引擎
  兜底**:本地模式失败不转投 AI(引擎归属必须可区分,`resolve_draw_ocr`
  本就按所选模式互斥解析,最多交给一个引擎);
- AI 产出表格的页同样跳过文本层切分(顺带修复 force AI 模式下
  AI 表格与文本层表格重复的既有缺陷);
- `ocr_pages` 统计包含照片页.

### 2.3 前端补图

`DrawTableResult` 新增 `imagePages: number[]`(后端 `image_pages`,
camelCase 序列化):

- `mergeDrawResults` 取并集;
- `extractWithOcr` 多页路径的补图条件由 `emptyTextPages` 扩展为
  `emptyTextPages ∪ imagePages`(均限定在目标页内);
- `handleExtract` 的 OCR 门槛放宽为 `ocrMode !== "disabled"`
  (原 `mayNeedOcr` 门槛会挡掉被判为 TextBased 的照片页):
  - 多页文档首次仍是无图调用,纯文本文档零新增成本;
  - 单页/少页(≤6)路径直接带图,代价是每次提取多渲染当前页 PNG.

### 2.4 改动范围

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/core/line_draw.rs` | 图片 bbox 收集 + 相交判定 + 路由条件 + `image_pages` 输出 + 单测 |
| `src-tauri/src/models.rs` | `DrawTableResult.image_pages`(serde camelCase) |
| `src/lib/types.ts` | `DrawTableResult.imagePages` |
| `src/components/draw-table/draw-table-panel.tsx` | `mergeDrawResults` 并集;`extractWithOcr` 补图条件;`handleExtract` 门槛放宽 |

## 3. 验收清单

1. 照片在页面右侧、左侧有文字的 PDF,画线覆盖照片 → 提取以渲染图 OCR
   为准,按划线切分照片内容;
2. 纯文本页(无照片或照片与划线不相交)结果与改动前一致;
3. force 模式行为不变;`disabled` 保持纯文本层;
4. 多页"应用到所有页"时,首次无图调用返回的 `imagePages` 触发补图二调,
   且首次调用**不产出**该页的文本层表格(不与二调的 OCR 表格重复);
5. 带隐形 OCR 文本层的照片扫描页,提取结果只来自渲染图 OCR,不混入
   隐形文本层内容;
6. `cargo test`(line_draw 单测)与 `tsc --noEmit` 通过.
