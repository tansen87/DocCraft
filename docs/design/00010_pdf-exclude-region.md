# PDF 识别排除区域(Exclude Region)设计方案

状态:**P0 已实施**(P1/P2 未开始)
关联:`src/views/pdf-to-md.tsx`(批量视图)、`src/components/pdf2md/*`(单文件工作区)、
`src-tauri/src/core/{convert,ocr,grid_rebuild,extract_cache,region_exclude}.rs`、
`docs/design/00009_feature-expansion-proposals.md`

落地位置:P0
- 后端 `core/region_exclude.rs`(新增)、`grid_rebuild::rebuild_pages_excluding`、
  `convert.rs` / `ocr.rs::start_session` 接入、`lib.rs` 两个命令新增 `exclusions` 参数
- 前端 `lib/exclude-region.ts`、`components/pdf2md/{exclude-overlay,exclude-panel}.tsx`(新增)、
  `pdf-preview.tsx`(`renderPageOverlay`)、`render-pdf-pages.ts`(遮罩)、
  `convert-workspace.tsx`(排除模式状态)、`convert-toolbar.tsx`(入口)

---

## 1. 需求

转换 PDF 时,允许用户在页面上**拖拽框选一个或多个矩形区域**,这些区域**不参与识别**:

- 典型场景:页眉/页脚(公司名、页码)、水印、侧边装饰条、二维码/条码、封面印章、
  表格中不需要的备注栏、双栏排版里的边注。
- 每个矩形可选择**仅作用于当前页**或**应用到每一页**(页眉页脚是主要用例)。
- 排除后,该区域的内容不出现在最终 Markdown 中。

---

## 2. 现状:PDF → Markdown 的两条通道

本项目**后端从不渲染 PDF**——需要 OCR 的页面一律由**前端 pdf.js 渲染成 PNG(base64)逐页送后端**。
因此"排除区域"必须在两条通道上分别落地:

```
                        ┌── 通道 A:需要 OCR 的页(扫描件/图片页/强制 OCR) ──┐
                        │ 前端 pdf.js render(scale=2.5 ≈180DPI)           │
                        │   → canvas.toDataURL()                          │
                        │   → hybrid_page_ocr(sessionId, page, png)       │
                        │   → 本地 PaddleOCR / 远端 AI Vision             │
                        └────────────────────────────────────────────────┘
                        ┌── 通道 B:有文本层的页 ───────────────────────────┐
                        │ Rust: pdf-inspector::extract_pages_markdown     │
                        │     + extract_text_with_positions(TextItem[])   │
                        │   → grid_rebuild::rebuild_pages(行重建)         │
                        └────────────────────────────────────────────────┘
                                        ↓
                        finish_session / convert_pdf 按文档顺序拼装
```

关键代码坐标:

| 环节 | 位置 |
|---|---|
| OCR 页渲染(scale=2.5) | `src/components/pdf2md/render-pdf-pages.ts:28,35-69` |
| 转换编排(hybrid session) | `src/components/pdf2md/render-pdf-pages.ts:79-111` |
| 批量任务编排 | `src/views/pdf-to-md.tsx:108-160`(`convertWithOcr` 在 `:129`) |
| 单文件转换编排 | `src/components/pdf2md/convert-workspace.tsx:232-283` |
| 后端本地转换 | `src-tauri/src/core/convert.rs:16-74` |
| 后端 hybrid session 起点 | `src-tauri/src/core/ocr.rs:645-768` |
| 抽取缓存(FullExtraction) | `src-tauri/src/core/extract_cache.rs:8-22,78-90` |
| 逐页 markdown 重建 | `src-tauri/src/core/grid_rebuild.rs:20-46` |
| IPC 命令定义 | `src-tauri/src/lib.rs:114-152` |

### 2.1 已有的可复用先例

`DrawTableRequest` 已经实现了「几何图形 + 应用到每一页」,本方案直接对齐它的模型与坐标约定:

- `models.rs:207-213` `RegionRect { x, y, width, height }` —— 矩形,可直接复用;
- `models.rs:229-240` `PageDrawTable { page, ..., page_x, page_y, page_width, page_height }` ——
  每页带 pdfjs `rawDims` 原点/尺寸;
- `models.rs:259-267` `DrawTableRequest.use_for_all_pages / max_pages / total_pages` —— "应用到每一页"的
  解析逻辑在 `line_draw.rs:698-771`(取第一个有内容的页作模板,展开到全部页);
- `line_draw.rs:188-205` `filter_text_by_region` —— 已有的矩形相交判定(我们要的是它的**反向**);
- `src/components/draw-table/canvas-overlay.tsx:46-53` —— 画布坐标 → PDF 坐标换算。

---

## 3. 坐标系约定(务必统一,最容易踩坑)

三套坐标,统一规定**矩形一律以「pdfjs viewport 相对坐标、原点左下、单位 PDF point」存储**,
与 `PageDrawTable` / `DrawTableRequest` 完全一致:

| 消费方 | 空间 | 需要的换算 |
|---|---|---|
| 前端 overlay(绘制/回显) | CSS 像素,**原点左上** | `cssX = x * scale`,`cssY = (pageHeight - y - height) * scale` |
| 通道 A:OCR canvas 遮罩 | 设备像素,原点左上 | `px = x * 2.5`,`py = (pageHeight - y - height) * 2.5` |
| 通道 B:pdf-inspector `TextItem` | **绝对 user space**,原点左下 | 先减 `page_x/page_y`:`it.x - origin_x`,`it.y - origin_y`(见 `line_draw.rs:815-834`) |

要点:

1. **使用 `rawDims` 而非 `viewport.width/height`**:后者含 `userUnit` 缩放,会导致坐标与后端 PDF point
   不一致(见 `convert-workspace.tsx:152-166` 的注释与现有实现)。
2. **origin 偏移**:pdf-inspector 给的是绝对坐标,pdfjs viewport 左下角是 viewBox 原点
   `(page_x, page_y)`,比较前必须相减。
3. **每页尺寸可能不同**(混合纸张/横竖页):矩形点值在跨页应用时按目标页尺寸**裁剪**(clamp),见 §7.4。
4. **页面旋转**:`page.rotate != 0` 时 viewport 与 user space 不一致(draw-table 也有同样限制)。
   P0 阶段:进入排除模式时若发现旋转页,在该页角标提示且**跳过该页的排除**,不静默错切(见 §9 待定)。

---

## 4. 总体方案:双通道分别落地

```
用户框选矩形(PDF point, viewport 相对)
        │
        ├── 通道 A(OCR 页)── 前端:render 完成后 fillRect 涂白 → toDataURL
        │                      零后端改动,本地 OCR 与 AI Vision 同时生效
        │
        └── 通道 B(文本页)── 后端:TextItem 按矩形反向过滤 → 重新行重建
                               新建 core/region_exclude.rs
```

- **通道 A 为什么选"涂白"而不是"裁剪"**:裁剪会改变版面尺寸、破坏列对齐;涂白对 OCR 而言就是
  "一块没有文字的空白",识别结果天然不含该区域内容,且对本地/远端引擎一视同仁。
- **通道 B 为什么不能也走"渲染成图再 OCR"**:文本页本来零成本、零延迟、保真度最高,
  降级成 OCR 会显著变慢并引入识别错误。因此文本页走 **item 级过滤 + 重新行重建**。

### 4.1 与"需要 OCR 页判定"的顺序(重要)

后端先按**未过滤**的 markdown 判定哪些页需要 OCR,再施加排除过滤。否则"把整页内容都排除掉"
会让该页 markdown 变空,被 `merge_ocr_pages`(`grid_rebuild.rs:52-62`)和
`start_session`(`ocr.rs:711-718`)误判成"图片页"而送去 OCR(该页 OCR 又会被涂白,最终空转一圈)。
实施位置见 §6.3。

---

## 5. 数据模型

### 5.1 前端(`src/lib/types.ts`)

```ts
/** 一个排除矩形:pdfjs viewport 相对坐标,原点左下,单位 PDF point。 */
export interface ExcludeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 单页的排除定义 + 该页几何(来自 pdfjs rawDims)。 */
export interface PageExclude {
  page: number;            // 1-indexed
  rects: ExcludeRect[];
  pageX: number;
  pageY: number;
  pageWidth: number;
  pageHeight: number;
}

/** 每页几何(进入排除模式时一次性读取,不随请求发送)。 */
export interface PageGeometry {
  pageX: number;
  pageY: number;
  pageWidth: number;
  pageHeight: number;
  /** page.rotate;非 0 的页禁止绘制,并在"应用到每一页"下以空 rects 条目显式跳过。 */
  rotation: number;
}

export interface ExcludeRegions {
  pages: PageExclude[];
  /** true:pages[0] 的矩形应用到每一页(超出目标页尺寸部分裁剪)。 */
  useForAllPages?: boolean;
  totalPages?: number;
}
```

### 5.2 后端(`src-tauri/src/models.rs`)

复用现有 `RegionRect`,新增两个结构(命名/形状与 `PageDrawTable` + `DrawTableRequest` 对称):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageExclude {
  pub page: u32,
  pub rects: Vec<RegionRect>,
  pub page_x: f64,
  pub page_y: f64,
  pub page_width: f64,
  pub page_height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludeRegions {
  pub pages: Vec<PageExclude>,
  pub use_for_all_pages: Option<bool>,
  pub total_pages: Option<u32>,
}
```

---

## 6. 后端改动

### 6.1 新模块 `src-tauri/src/core/region_exclude.rs`

```rust
/// 解析"应用到每一页":模板页的矩形展开到 1..=total_pages(viewport 相对坐标)。
pub fn rects_for_page(spec: &ExcludeRegions, page: u32) -> Vec<RegionRect>;

/// 每页矩形(已平移到绝对 user space),未受影响的页不在 map 中。
pub fn page_filters(spec: &ExcludeRegions, page_count: u32) -> HashMap<u32, Vec<RegionRect>>;

/// 反向过滤:剔除与任一排除矩形相交的 TextItem。
pub fn filter_items(items: &[TextItem], filters: &HashMap<u32, Vec<RegionRect>>) -> Vec<TextItem>;

/// 单个文本项是否命中(供重建时逐项判断)。
pub fn hits_item(rects: &[RegionRect], it: &TextItem) -> bool;
```

相交判定(与 `line_draw.rs:188-205` 反向一致,保守剔除,避免残留半截文字):

```rust
let top = it.y + it.height.max(it.font_size);          // TextItem.y 视为底边
let hit = rects.iter().any(|r|
    it.x < r.x + r.width && it.x + it.width  > r.x &&
    it.y < r.y + r.height && top             > r.y);
```

### 6.2 重建受影响页(`grid_rebuild.rs` 扩展)

新增(而非改写现有 `rebuild_pages`,保证无排除时行为零变化):

入参直接取 `FullExtraction` 的四个切片(无需改 `extract_cache`,缓存里始终存放未过滤的结果):

```rust
pub fn rebuild_pages_excluding(
  page_markdowns: &[String],
  items: &[TextItem],
  pages_with_tables: &[u32],
  needs_ocr_flags: &[bool],
  spec: &ExcludeRegions,
) -> Vec<String>
```

逐页逻辑:

1. 取本页矩形 → 过滤 items;
2. 本页**未受影响**或 `page.needs_ocr` → 完全走现有逻辑(表格页保留 GFM 表格);
3. 本页受影响且不是 OCR 页 → 按 `has_table` 分流:
   - **表格页**:调用 `lines_to_table_markdown` 从剩余 items 重建 GFM 表格(首行作表头 +
     `---` 分隔行 + 数据行),保留表格语法而非退化为纯文本;
   - **非表格页**:调用 `lines_to_markdown` 重建纯文本行(现有行分组逻辑
     `grid_rebuild.rs` 直接复用)。
4. ~~表格页受影响时的降级~~(已修复):原先表格页受影响会退化为 `lines_to_markdown`
   纯文本行,导致"全部是表格的文本型 PDF"在排除区域模式下首页不再是表格。现改为
   `lines_to_table_markdown` 重建 GFM 表格,既保留表格结构又应用了排除。

### 6.3 接入点

| 位置 | 改动 |
|---|---|
| `lib.rs:114-127` `convert_pdf` | 新增参数 `exclusions: Option<ExcludeRegions>` |
| `lib.rs:139-152` `hybrid_session_start` | 同上 |
| `core/convert.rs:37-74` | 在 `merge_ocr_pages` **之后**(`convert.rs:57-61`)、`rebuild_document_for_pages` **之前**套用过滤 |
| `core/ocr.rs:645-768` `start_session` | 在空页 OCR 判定循环(`:711-718`)**之后**过滤,再把结果存入 `HybridSession.pages`(`:757`) |
| `core/extract_cache.rs` | **不改动**:过滤只在缓存副本上进行,绝不能写回缓存,否则后续无排除的转换被污染 |

> `ocr.rs` 里 OCR 页的 markdown 来自前端遮罩后的图片,后端无需处理;只有文本页需要过滤。

### 6.4 单元测试

沿用 `grid_rebuild.rs:162-220`、`line_draw.rs:1290+` 的测试风格,覆盖:

- `rects_for_page` 在 `use_for_all_pages` 开/关下的展开与越界裁剪;
- `filter_items`:完全包含 / 部分相交 / 边界相切 / 不相交;
- `rebuild_pages_excluding`:无矩形时与原 `rebuild_pages` 输出逐字节一致;
- 表格页受影响时的降级路径。

---

## 7. 前端改动

### 7.1 状态与入口

- `convert-workspace.tsx`:新增 `excludeMode`(与现有 `drawMode` **互斥**,`toggleDrawMode`
  处同样处理,见 `:311-318`),以及 `excludePages: PageExclude[]`、`useForAllPages: boolean`。
- 进入模式时一次性拉取**每页几何**(`doc.getPage(i).getViewport({scale:1}).rawDims` + `page.rotate`),
  缓存为 `pageGeom: Record<number, {...}>`;切文件/退出模式即清空(参考 `:142-207` 的现有取尺寸逻辑)。
- 工具栏 `convert-toolbar.tsx:102-123` 旁新增同款分段按钮「排除区域」(图标 `SquareDashedMousePointer` /
  `Eraser`),tooltip 说明;与「Draw Table」互斥禁用。

### 7.2 覆盖层

- `pdf-preview.tsx:323-358` 的每页 wrapper 增加 `relative`,并新增可选 prop:

  ```tsx
  renderPageOverlay?: (page: number, geom: { width: number; height: number; scale: number }) => ReactNode;
  ```

  这样复用现有的虚拟化渲染(IntersectionObserver + 按需 render),不必新写预览器。
- 新组件 `src/components/pdf2md/exclude-overlay.tsx`(SVG,与 `canvas-overlay.tsx` 同构):
  - 按下拖拽 → 松手生成矩形(`crypto.randomUUID()`,同 `canvas-overlay.tsx:65`);
  - 单击选中 / 拖拽移动 / 八向 resize handle;双击或 `Delete`/`Backspace` 删除;
  - `Esc` 退出排除模式;
  - 小于阈值(~8pt)的拖拽视为误操作丢弃;
  - 视觉:琥珀色 `stroke-dasharray` + 12% 填充 + 45° 斜线 `pattern`,与 draw-table 的红/蓝线条区分;
  - 右下角实时显示 `PDF: (x, y) · W×H`(沿用 `canvas-overlay.tsx:221-232` 的坐标指示器)。
- 右侧浮动小面板(贴 PDF 窗格右上):矩形列表(页号徽标 + 尺寸)、
  **「应用到每一页」开关**、「清空全部」、一句操作提示。

### 7.3 通道 A 遮罩(`render-pdf-pages.ts`)

```ts
// renderPdfPagesForOcr():page.render() 之后、toDataURL() 之前
const rects = exclusions ? rectsForPage(exclusions, pageNum) : [];
if (rects.length) {
  ctx.fillStyle = "#ffffff";
  for (const r of rects) {
    ctx.fillRect(
      r.x * OCR_RENDER_SCALE,
      (pageHeight - r.y - r.height) * OCR_RENDER_SCALE,   // 原点翻转
      r.width * OCR_RENDER_SCALE,
      r.height * OCR_RENDER_SCALE,
    );
  }
}
```

`renderPdfPagesForOcr(path, pages)` → 增加可选 `exclusions?: ExcludeRegions`;
`convertWithOcr(path, pages, onProgress, isCancelled, pageRange)` → 追加第 6 个可选参数,
并透传给 `startHybridSession`。

### 7.4 "应用到每一页"的跨页裁剪

实现取舍(与最初的设想略有不同):矩形统一**按模板页尺寸裁剪**
(`rects_for_page` / `rectsForPage`,前后端同构),而不是按每一页的实际尺寸。

- 目标页**更大**:矩形保持用户绘制的原始几何,不随纸张放大 —— 符合"我画的这块"的直觉;
- 目标页**更小**:超出部分在渲染(`fillRect` 越界自动裁剪)与文本过滤(越界处没有文本项)时
  自然失效,等价于被裁掉;
- 好处是两条通道(OCR 遮罩 / 文本过滤)与前后端完全一致,不会出现"同一页两种裁法"。

默认锚点为**左下原点**(与存储坐标一致);「按页边距锚定」(页眉/页脚贴边对齐)列为 P2,
见 §9 待定项 3。

### 7.5 IPC

`src/lib/ipc.ts:27-51`:

```ts
convertPdf(path, pageRange?, exclusions?)                    // 新增第 3 参
startHybridSession(path, ocrPages, pageRange?, exclusions?)   // 新增第 4 参
```

调用方:

- `convert-workspace.tsx:243-263`(单文件路径);
- `pdf-to-md.tsx:127-130`(批量路径)—— **P0 阶段不接入批量**,见 §8。

---

## 8. 批量视图(`src/views/pdf-to-md.tsx`)

P0 排除区域只在**单文件工作区**(`ConvertWorkspace`)生效:批量列表里每个文件是不同文档,
共用一套矩形通常没有意义,静默套用风险高。

P2 方案:批量工具栏提供「使用当前排除区域」开关,打开后 `runJob`(`:108-160`)把同一份
`ExcludeRegions` 透传给每个文件,并在表格里显示标记。默认关闭。

---

## 9. 待定 / 已知限制

1. **表格页受排除区域影响**:被排除矩形触及的表格页现在通过 `lines_to_table_markdown`
   从剩余 items 重建 GFM 表格(而非退化为纯文本行),保留表格语法同时应用排除。
   ~~原先的"表格页降级"取舍已修复。~~
2. **深色底 PDF**:涂白会留下亮块;OCR 不受影响(无文字),但 AI Vision 模型理论上可能"看见"色块。
   是否需要改为"取该页边缘主色填充"?倾向 P0 用白,保持简单。
3. **页边距锚定**:页眉页脚在跨不同纸张时希望"贴顶/贴底"而非固定点值。P2。
4. **旋转页**:`page.rotate != 0` 时 P0 跳过并在角标提示;是否要做矩形旋转变换?P2。
5. **持久化**:P0 为会话内状态(切文件即清空)。是否需要按 `path+mtime` 存 localStorage / 后端 JSON 记忆?P2。
6. **Draw Table 模式**是否也遵守排除区域?P0 不接入(两套模式互斥)。

---

## 10. i18n

在 `src/i18n/translations.ts` 的 `en` 与 `zh`(类型由 `keyof typeof en` 自动约束)同时新增:

```
toolbar.excludeRegion / toolbar.enterExclude / toolbar.exitExclude
exclude.applyAllPages / exclude.applyAllPagesHint / exclude.clearAll
exclude.empty / exclude.emptyHint / exclude.rectCount("{count}")
exclude.deleteHint / exclude.dragHint / exclude.rotationSkipped
notice.tableDegraded("{count}") / toast.excludeApplied
```

---

## 11. 验收标准

1. 框选页眉后转换,输出 Markdown 中不含页眉文字(文本型 PDF 与扫描型 PDF 各测一份)。
2. 打开「应用到每一页」,100 页文档仅首页有矩形时,全部页的对应区域均被排除。
3. 无矩形时,转换结果与改动前**逐字符一致**(回归基线)。
4. 矩形跨页到更小页面时被正确裁剪,不越界、不抛错。
5. 混合纸张 + 横竖混排文档不产生坐标偏移(对照手动框选位置与排除结果)。
6. 拖拽/移动/resize/删除/双击/Esc 交互流畅,未选中矩形不干扰页面滚动。
7. 关闭 OCR(`ocrMode = disabled`)时,`convert_pdf` 路径同样生效。
8. `cargo test` 新增用例全绿;前端 `tsc` + 构建通过。

---

## 12. 实施计划

| 阶段 | 内容 | 预估 |
|---|---|---|
| P0 | 后端 `region_exclude.rs` + `grid_rebuild` 扩展 + 两个命令参数;前端遮罩 + 排除模式 UI(绘制/编辑/列表/应用到每一页)+ i18n | ★★★ **已完成** |
| P1 | `ConvertResult.degradedPages` + 状态栏提示;旋转页提示;单元/手工测试 | ★☆(约 0.5 天) |
| P2 | 批量视图接入、按文件持久化、页边距锚定、旋转页支持 | ★★(约 0.5–1 天) |
