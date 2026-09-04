# 划线(Draw Table)模式支持排除区域

状态:**已实施**
前置:`docs/design/00010_pdf-exclude-region.md`(本文是其 §9 待定项 6 的落地)
关联:`src/components/pdf2md/convert-workspace.tsx`、`src/components/draw-table/draw-table-panel.tsx`、
`src/lib/exclude-region.ts`、`src-tauri/src/core/{line_draw,region_exclude}.rs`

落地位置:

- 后端 `core/region_exclude.rs`(新增 `hits_box` / `split_box_outside`)、
  `core/line_draw.rs::extract_tables_from_draw_lines`(接入)、`models.rs::DrawTableRequest`(新增 `exclusions`)
- 前端 `lib/exclude-region.ts`(`maskExclusions` 上提为共享工具)、
  `components/draw-table/draw-table-panel.tsx`(覆盖层挂载点 + OCR 遮罩 + 请求透传)、
  `components/pdf2md/{convert-workspace,convert-toolbar}.tsx`(两模式共存)

---

## 1. 需求

`00010` 的 P0 只在**普通转换通道**接入了排除区域,划线模式被刻意排除在外
(`00010` §9 待定项 6:「Draw Table 模式是否也遵守排除区域?P0 不接入(两套模式互斥)」)。

实际使用中划线模式同样需要排除:扫描件表格常带页眉页脚/水印/骑缝章,用户画好竖线切列之后,
这些区域的内容仍然被切进表格里。现在要求:**划线模式下也能框选排除区域,提取时该区域不参与**。

---

## 2. 现状:为什么 P0 用不了

三条原因,逐条对应改造点:

| # | 原因 | 位置 |
|---|---|---|
| 1 | 两个模式被强制互斥 | `toggleDrawMode` `:438`(`setExcludeMode(false)`)、`toggleExcludeMode` `:444`(`setDrawMode(false)`)、工具栏互禁 `convert-toolbar.tsx:117/140` |
| 2 | 渲染面不同:排除层挂在 `PdfPreview.renderPageOverlay` 上,而划线分支根本不渲染 `PdfPreview` | `convert-workspace.tsx:567`(drawMode 分支)vs `:623`(PdfPreview) |
| 3 | 协议与后端不支持:`DrawTableRequest` 无 `exclusions` 字段,`line_draw.rs` 无排除逻辑,划线模式自己实现的 `renderPageImages` 也没有遮罩 | `models.rs:259-279`、`line_draw.rs`、`draw-table-panel.tsx:192-226` |

补充:划线模式的 OCR 渲染是**另一套平行实现**(不复用 `render-pdf-pages.ts`),
  且渲染倍率为 `2.5`(`draw-table-panel.tsx:24-26`),
所以遮罩函数必须把倍率作为参数,不能直接抄 `render-pdf-pages.ts:39-58` 里硬编码 `2.5` 的版本。

---

## 3. 坐标系:两条通道天然一致(关键前提)

划线模式与排除区域**本来就共用同一套坐标**,这是本次能低成本打通的根本原因:

| 环节 | 坐标空间 |
|---|---|
| `CanvasOverlay.canvasToPdf`(`canvas-overlay.tsx:47-53`) | 视口相对 PDF point,原点左下 |
| `ExcludeOverlay.toPdf`(`exclude-overlay.tsx:93-99`) | 视口相对 PDF point,原点左下 |
| `DrawTableRequest.pages[].pageX/pageY/...` | 来自 pdfjs `rawDims` 的视口原点与尺寸 |
| `line_draw.rs:828-835` 的 element | 已由绝对 user space **减** `(page_x, page_y)` 平移到视口相对 |

所以:

- **后端过滤点在 `line_draw.rs:828-835` 之后** —— 此时 elements 已是视口相对,可直接用
  `region_exclude::rects_for_page(spec, page)`(`00010` 里的 `page_filters` 是给绝对坐标用的,
  这里**不能**用,否则重复平移)。
- **前端遮罩直接复用 `rectsForPage`**,无需任何坐标换算。

---

## 4. 总体方案

```
用户在划线模式下打开「排除区域」
        │
        ├── 竖线/横线:CanvasOverlay 照旧(CanvasOverlay 在 ExcludeOverlay 之下)
        ├── 排除矩形:ExcludeOverlay 叠在 CanvasOverlay 之上
        │
        ├── 文本页 ── 后端 line_draw:element 按矩形反向过滤 → 再切列
        ├── 本地 OCR 页 ── 前端 renderPageImages 涂白 → OCR 看不到;后端再兜底过滤一次
        └── AI Vision 页 ── 只能靠前端涂白(模型直接吐 GFM 表格,后端无法按坐标剔除)
```

> **指针归属与操作顺序**(见 §6.4、§9.2):两个覆盖层**同屏共存**,指针按当前工具
> 交接——线工具时 `ExcludeOverlay` 置 `pointer-events-none`,排除工具时反过来。
> 划线/排除**没有先后要求**;真正有依赖的是「提取」至少需要一条竖线。

### 4.1 过滤顺序:必须在「空页判定」之后

`line_draw.rs:882-884` 会把没有文本的页记进 `empty_text_pages`,前端据此决定是否走 OCR
(`draw-table-panel.tsx:424`)。若先施加排除,一页被排除干净就会被误判成"图片页"送去 OCR ——
与 `00010` §4.1 完全同构的问题。

因此过滤点落在 **`:884` 之后、`:887` 之前**:OCR 路由按未过滤文本判定,排除只影响最终参与切列的元素。

### 4.2 部分相交用「字符级切分」而非整项丢弃

pdf-inspector 会把同一视觉行的多个列合并成一个 item(如 `"Alice  28  Beijing"`)。
若某列带(排除矩形)覆盖了行的中段,整项丢弃会**抹掉整行**。

`00010` 已实现 `split_outside`(按 `width/char_count` 估算字宽,保留矩形外的字符段并**保留各段原始 x**)。
本次把它上提为与类型无关的 `split_box_outside`,同时供:

- `filter_items`(`TextItem`,普通转换通道)
- `filter_elements`(`TextElement`,划线通道)

**保留原始 x 对划线模式尤其重要**:切分后的片段 x 不变,用户画的竖线才能把它们切回正确的列,
不会出现"排除中间列后,右侧列左移一列"的错位。

### 4.3 OCR 通道:前端涂白为主,后端过滤兜底

- **AI Vision**:模型直接返回 GFM 表格,后端无法按坐标剔除 → **必须**前端涂白。
- **本地 PaddleOCR**:前端涂白已足够;后端仍过滤一次,保证即使某个调用方没传图也能生效。

---

## 5. 后端改动

### 5.1 `core/region_exclude.rs` 抽出与类型无关的两个原语

```rust
/// 元素包围盒是否与任一矩形相交(矩形与元素须在同一坐标空间)。
pub fn hits_box(
  rects: &[RegionRect], left: f64, bottom: f64, width: f64, height: f64,
) -> bool;

/// 返回矩形外的保留片段 (left, width, text):
/// 不相交 → 原样返回一项;完全覆盖 → 空;部分覆盖 → 按字符切分成多段(保留原始 x)。
pub fn split_box_outside(
  rects: &[RegionRect], left: f64, bottom: f64, width: f64, height: f64, text: &str,
) -> Vec<(f64, f64, String)>;
```

`hits_item` / `filter_items` / `split_outside` 改为基于这两个原语实现,行为**零变化**
(既有 9 个单元测试即回归基线)。

### 5.2 `models.rs::DrawTableRequest` 新增字段

```rust
/// Regions whose content must not be recognized, in the same
/// viewport-relative space as `pages[].page_x/page_y`.
pub exclusions: Option<ExcludeRegions>,
```

`lib.rs::extract_draw_table` / `extract_draw_table_to_markdown` **无需改动** —— 它们整体透传 `draw_data`。

### 5.3 `core/line_draw.rs` 接入

新增私有辅助(与 `filter_text_by_region` 同一坐标系):

```rust
/// 剔除矩形内的内容:完全覆盖的元素丢弃,部分覆盖的按字符切分(保留原始 x 以免错列)。
fn filter_elements(rects: &[RegionRect], elements: Vec<TextElement>) -> Vec<TextElement>;
```

在 `extract_tables_from_draw_lines` 的每页循环中插入(`:884` 之后):

```rust
if let Some(spec) = &request.exclusions {
  let rects = region_exclude::rects_for_page(spec, page_num);
  if !rects.is_empty() {
    elements = filter_elements(&rects, elements);
  }
}
```

无 `exclusions` 时该分支整体跳过 → 与改动前**逐字节一致**。

### 5.4 单元测试

- `split_box_outside`:不相交 / 完全覆盖 / 中段切分(保留 x)/ 边界相切 / 空白片段丢弃;
- `hits_box` 与既有 `hits_item` 行为一致;
- `filter_elements` 风格用例:合并行被竖带穿过时,两侧片段各回原列。

---

## 6. 前端改动

### 6.1 `lib/exclude-region.ts`:`maskExclusions` 上提为共享工具

从 `render-pdf-pages.ts:39-58` 移出并加 `scale` 参数(划线模式有 2.5/4.0 两档):

```ts
export function maskExclusions(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  page: number,
  exclusions: ExcludeRegions | null | undefined,
  scale: number,
): void;
```

`render-pdf-pages.ts` 改为 import 使用(行为不变)。

### 6.2 `types.ts::DrawTableRequest` 新增 `exclusions?: ExcludeRegions | null`

### 6.3 `draw-table-panel.tsx`

| 改动 | 说明 |
|---|---|
| props 新增 `exclusions?: ExcludeRegions \| null` | 由工作区传入 `exclusionSpec` |
| props 新增 `renderPageOverlay?: (page: number) => ReactNode` | 与 `PdfPreview` 同名 prop 对称,渲染在 `CanvasOverlay` **之后**(即其上) |
| `renderPageImages` `:192-226` | `page.render()` 之后、`toDataURL()` 之前调用 `maskExclusions(ctx, canvas, pageNum, exclusions, renderScale)` |
| `handleExtract` `:469-473` | request 带上 `exclusions`;`extractWithOcr` 内 3 处 IPC 都 spread `...request`,自动透传 |

> `renderPageImages` 的 `useCallback` 依赖需加入 `exclusions`。

### 6.4 `convert-workspace.tsx`:两模式共存

1. **去掉互斥**:`toggleDrawMode` 删掉 `setExcludeMode(false)`;`toggleExcludeMode` 删掉 `setDrawMode(false)`。
   两个模式**状态可同时为真**。
2. **覆盖层工厂上提**:把 `PdfPreview.renderPageOverlay` 里的匿名函数抽成 `renderExcludeOverlay(page)`,
   drawMode 分支与 normal 分支共用。
3. **drawMode 分支**:`<DrawTablePanel renderPageOverlay={renderExcludeOverlay} exclusions={exclusionSpec} />`。
   覆盖层拿到的是 `currentPage` 的几何(`pageGeom[currentPage]`),与面板正在显示的页一致。
4. **`ExcludePanel` 在两种模式下都渲染**(列表 + 应用到每一页 + 清空)。
5. **状态栏 `extra`**:两模式同时开启时显示 `划线 · 排除区域`,而非三元只显示一个。
6. **划线面板内三态工具**(竖线 / 横线 / 排除,见 §9 落地):
   - 工具状态 `DrawTool = "vertical" | "horizontal" | "exclude"` 是**当前模式的唯一事实来源**。
   - 两个覆盖层**同屏共存**:线工具时 `ExcludeOverlay` 包一层 `pointer-events-none`(矩形仍可见、不可编辑),
     排除工具时 `CanvasOverlay` 置 `pointer-events-none`。谁拿到指针由工具唯一决定,
     不再有"全屏透明命中层独占指针"。
   - `DrawTableToolbar` 增加「排除」分段(active 高亮 `variant="secondary"`),instruction 文案随工具切换;
     选「排除」时回调 `setExcludeMode(true)` 打开编辑器(加载 `pageGeom`、显示 `ExcludePanel`)。
   - 编辑器被关闭(Esc / 工具栏按钮)且当前工具为「排除」时,面板自动回退到竖线,避免指针无归属。

> `pageGeom` 的加载守卫保持 `if (!excludeMode) return` 不变:只有真正打开排除编辑器才需要逐页几何,
> 与是否处于划线模式无关。

### 6.5 `convert-toolbar.tsx`

- 「Draw Table」`disabled={busy}`(去掉 `|| excludeMode`)
- 「排除区域」`disabled={busy}`(去掉 `|| drawMode`)
- 「Convert」保持 `disabled={busy || drawMode}`(划线模式用「提取」而非「转换」)

---

## 7. i18n

无新增 key:状态栏 `extra` 复用既有 `mode.drawTable` 与 `toolbar.excludeRegion` 组合。

---

## 8. 验收标准

1. 划线模式下开启「排除区域」,框选页眉 →「提取」输出的表格不含页眉文字。
2. 关掉「排除区域」后,仍能正常点击添加竖线/横线(覆盖层不残留指针拦截)。
3. **划线/排除顺序无关**:先框选排除区域再画竖线、或先画竖线再框选区域,提取结果一致;
   排除工具开启时切回竖线/横线工具,矩形保持可见但可正常画线。
3. 未画任何矩形时,划线模式提取结果与改动前**逐字符一致**。
4. 竖带排除某一列时,合并行(`"Alice  28  Beijing"`)两侧片段**各回原列**,不发生左移错位。
5. 扫描件(无文本层)走 OCR 时,排除区域同样不出现在结果里(本地 OCR 与 AI Vision 各测一份)。
6. 「应用到每一页」在划线模式下同样生效。
7. 旋转页仍然 opt-out(覆盖层 inert + spec 里显式空条目)。
8. `cargo test` 全绿;前端 `tsc` + 构建通过。

---

## 9. 已知限制

1. **AI Vision 通道依赖前端涂白**:若将来出现不经前端渲染就送图的路径,该通道会失效。
2. **「提取」依赖竖线**:后端只有在存在竖线/横线时才产出表格(`line_draw.rs:953`),
   只框选排除区域而不画任何线会得到空结果 —— 前端「提取」按钮以 `hasLines` 禁用已覆盖此情形,与操作顺序无关。
3. **`pageCount` 硬编码上限 5**(`convert-workspace.tsx:583`):既有问题,本次不触碰。
4. **混合纸张文档的划线模式**:划线面板本身就用**第 1 页**的尺寸与缩放渲染所有页
   (`convert-workspace.tsx:161-226`,`CanvasOverlay` 的 `scale` 对所有页相同),
   所以不同尺寸的页上竖线位置本就不准。排除覆盖层取的是**当前页真实几何**
   (`pageGeom[currentPage]`),语义正确但与画布的视觉对齐同样受该既有问题影响。
   要使混合纸张文档完全正确,需要先让划线面板按页渲染 —— 超出本次范围。
