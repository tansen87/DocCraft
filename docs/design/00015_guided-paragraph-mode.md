# 00015 - ParagraphMode 新增 Guided 模式(用户自定义列区域合并文本行)

- 状态: 已完成
- 日期: 2026-09-01
- 关联文档: 00013(段落换行启发式)、00014(PDF 段落换行模式设计)

## 1. 背景与目标

### 1.1 现状

ParagraphMode 目前支持三种模式: 

| 模式 | 行为 |
| --- | --- |
| `keep` | 保留原始换行,不做合并 |
| `smart`(默认) | 按 00013 启发式判断软/硬换行,软换行合并 |
| `none` | 所有换行视为硬换行,全部不合并 |

`smart` 的启发式(如 T1: 行以句末标点结尾判为硬换行)对通用文本有效,但对表格类截图存在双向误判: 

- 同一列的多行折行文本本属一个语义段落(如「描述」列的折行内容),可能因某行以句号结尾被切开;
- 「Value Date / Acc Date」这类短值列不希望被合并,却可能因启发式误判被合并.

假设数据如下表格,需要合并文本行的数据只有description:

| Account    | value date | acc date   | description   |
| ---------- | ---------- | ---------- | ------------- |
|            | 2026-01-01 | 2026-12-31 | New game      |
| 1001010101 | 2026-02-01 | 2026-12-31 | hello         |
|            |            |            | world         |

得到的结果应该是:

| Account    | value date | acc date   | description   |
| ---------- | ---------- | ---------- | ------------- |
|            | 2026-01-01 | 2026-12-31 | New game      |
| 1001010101 | 2026-02-01 | 2026-12-31 | hello world   |

### 1.2 目标场景(以用户截图为基准)

表格截图包含 `Description`、`Value Date`、`Acc Date` 等列,期望: 

- **Description 列**: 折行多行合并为一个单元格文本段;
- **Value Date / Acc Date 列**: 保持逐行,不合并.

结论: 需要一种由用户显式指定「哪些列合并、哪些列不合并」的模式,即 **Guided(引导式)模式**——用户画竖线划分列,再点选需要合并的列区域,系统仅对选中列执行文本行合并.

## 2. 需求与交互设计

### 2.1 触发入口

ParagraphMode 新增第四个取值 `guided`.用户选择 `guided` 后进入列区域引导流程(截图 OCR / 图片表格路径均可用).

### 2.2 交互流程

1. **画竖线**: 复用 draw-table 既有画线交互,用户在预览图上画一条或多条竖线,将页面按列切分.竖线 x 坐标排序后形成列边界;页面左右边缘默认作为首尾边界.
2. **点击 Merge Column**: 工具栏在竖线、横线、排除区域控件的**右侧**新增 `Merge Column` 按钮.点击后进入列点选状态,竖线之间的列区域以高亮描边展示.
3. **点选合并列**: 用户点击若干列区域,被选中的列高亮填充(再次点击可取消).这些列即「合并列」.
4. **确认执行**: 点击识别/提取后,系统按列边界切分文本行——合并列内的行执行合并,非合并列保持逐行.

### 2.3 交互细节与边界

- `Merge Column` 是开关型工具按钮: 激活时画布上的列区域可点选;未激活时保持普通画线交互.
- 至少画一条竖线后 `Merge Column` 按钮才可用;未选中任何合并列时,`guided` 行为等同 `keep`(全部不合并),UI 需给出提示.
- 竖线后续增删导致列数变化时,已选合并列按列序号(从左到右 0-based)保持映射;列数减少导致序号越界时丢弃越界项并提示.
- 竖线默认按全页高度处理(与 draw-table 一致),是否支持局部高度竖线留待后续反馈.

## 3. 数据结构

### 3.1 前端 `types.ts`

```ts
export type ParagraphMode = 'keep' | 'smart' | 'none' | 'guided';

export interface GuidedMergeConfig {
  /** 竖线 x 坐标(页面像素,升序) */
  verticalLines: number[];
  /** 横线 y 坐标(升序),可选 */
  horizontalLines?: number[];
  /** 需要合并的列序号(0-based,从左到右) */
  mergeColumns: number[];
}
```

### 3.2 后端 `models.rs`

现有 [models.rs 的 `ParagraphMode`](src-tauri/src/models.rs) 走 `TryFrom<String>` 反序列化(非 `serde` 直出),故新增 `Guided` 时须同步补映射,而非仅加一个变体: 

```rust
pub enum ParagraphMode {
    /// 逐行保留
    #[default]
    Keep,
    /// 智能合并段落内软换行
    Smart,
    /// 整页不换行(表格/代码块除外)
    None,
    /// 引导式: 仅按用户选定的列合并(本设计)
    Guided,
}

impl TryFrom<String> for ParagraphMode {
  type Error = std::convert::Infallible;
  fn try_from(s: String) -> Result<Self, Self::Error> {
    Ok(match s.trim().to_ascii_lowercase().as_str() {
      "smart" | "unwrap" | "paragraph" => Self::Smart,
      "none" | "single" | "nolinebreak" => Self::None,
      "guided" | "manual" | "columns" => Self::Guided,   // 本设计新增
      _ => Self::Keep,   // 未知值 / 旧配置 → 回落现状
    })
  }
}

#[derive(Deserialize, Default)]
pub struct GuidedMergeConfig {
    pub vertical_lines: Vec<f32>,
    #[serde(default)]
    pub horizontal_lines: Vec<f32>,
    #[serde(default)]
    pub merge_columns: Vec<usize>,
}
```

请求体在现有段落模式设置基础上新增可选 `guided` 字段(`GuidedMergeConfig`);`mode = guided` 时必填,缺失时返回参数错误.

兼容性要点: `#[default]` 必须仍落在 `Smart` 上(保证缺字段的老配置不会被误判成 `Keep`,前端兜底 `"smart"` 与后端一致);`GuidedMergeConfig` 全员 `#[serde(default)]`,老 `app-settings.json` 导入后回落空配置(等同 `keep`).未知的段落模式字符串(包括用户手改损坏的配置)一律回落 `Keep`,不因 `guided` 引入而改变既有容错行为.

## 4. 算法设计

### 4.1 列切分与行归属

1. 边界序列 `B = [0, v1, v2, ..., vk, W]`,`vi` 为排序后的竖线 x 坐标;相邻边界构成列区间.
2. 若提供了横线,先按横线将页面切分为行带,行归属在行带内进行(与 draw-table 行分组语义一致).
3. 对每个 OCR 文本行(含 bbox),计算其与各列区间的水平重叠,归入**重叠最大**的列;跨列行(如整行表头)不强行切分,整体归入重叠最大的列.

### 4.2 合并规则

- **合并列**: 列内行按 y 升序,逐行调用现有 `join_fragments` 拼接(CJK-CJK 无空格、拉丁词间单空格),与 00014 图片表格网格模式的拼接规则保持一致.
- **非合并列**: 保持原始行,不拼接.
- **优先级**: `guided` 为用户显式指定,**覆盖 00013 全部启发式**(含 T1 句末标点判硬换行).合并列内即使某行以句号结尾也合并.此差异为有意设计,避免 00013/00014 已知的语义冲突在 `guided` 模式下重现.

### 4.3 输出

- **截图 / snip 路径**: 返回合并后的文本块列表,结构不变,仅文本内容按列规则重排.
- **图片表格路径**: 单元格文本按上述规则生成;`DrawTableResult` 结构不变,`ocr_confidence` 链路不受影响.

**区域截图(非表格)路径的呈现顺序需明确**: `guided` 在纯区域截图下并不产出 GFM 表格,输出仍是 Markdown 文本块.为与用户「按列划分」的心理模型一致,默认**行主序输出**(按 y 升序遍历逻辑记录,每条记录的单元格依次拼接,`text_separator` 分隔列、合并列内拼接折行);若某记录某列为空则占位空.不采用列主序(会破坏阅读顺序).若后续有按列导出需求,另立设计.

## 5. 模块改动

### 5.1 后端

| 模块 | 改动 |
| --- | --- |
| `models.rs` | `ParagraphMode` 增加 `Guided`;新增 `GuidedMergeConfig` |
| `snip.rs` | 读取段落模式处增加 `guided` 分支;新增列切分与按列合并逻辑(P0 核心) |
| `line_draw.rs` / `extract_tables_from_draw_lines` | draw-table 划线路径透传 `GuidedMergeConfig`;`force_ocr` 组合行为回归 |
| 单测 | snip 专项单测新增 `guided` 用例 |

### 5.2 前端

| 模块 | 改动 |
| --- | --- |
| `types.ts` | `ParagraphMode` 联合类型加 `'guided'`;新增 `GuidedMergeConfig` |
| `draw-table-panel`(或独立 guided 面板) | 复用画线交互;新增 `Merge Column` 工具按钮(位于竖线/横线/排除区域控件右侧)与列点选状态 |
| `convert-workspace` / `snip-result-window` | 模式切换、配置传递、结果渲染 |

## 6. 测试计划

### 6.1 单元测试

- 列边界计算: 0 / 1 / 多条竖线,乱序输入;
- 行归属: 列内行、跨列行(取最大重叠)、贴边行;
- 合并列拼接: 多行合并、CJK/拉丁混合、单行列;
- 非合并列保持原行;
- `merge_columns` 为空或越界时降级为 `keep`;
- **记录边界保护(§4.2 核心)**: 同一合并列内 `New balance` 与 `Purchase on stock / MANULIFE` 之间间距超 `ROW_GAP_EM` → 断言拆为两条记录、不并成一段;同记录 `Purchase on stock` + `MANULIFE` → 断言合并为一段;
- **空列占位**: 跨列空行归属时列内空单元格保留占位(`new balance` 记录的 value/acc date 为空).

### 6.2 集成场景(以用户截图为验收样例)

- `Description`(合并)+ `Value Date` / `Acc Date`(不合并): 期望 Description 折行合并为一段,日期列逐行;
- 本地 PaddleOCR 与远程 AI Vision 两条 OCR 链路均覆盖;
- `guided` + 划线提取 `force_ocr` 组合回归.

## 7. 实施步骤

- **P0(后端)**: 枚举与配置模型(含 `TryFrom` 映射)、`snip.rs` 列切分 + 按列门控续行折叠(复用 `fold_continuation_rows`/`ROW_GAP_EM`)、专项单测.
- **P1(前端)**: `Merge Column` 交互、配置传递、以用户截图为验收样例验证结果;`line_draw.rs` 划线路径透传 `GuidedMergeConfig`.
- **P2**: 图片表格网格模式接入、跨列行按竖线物理切分、guided 配置持久化.

> 阶段归属说明: `line_draw.rs` 划线(draw-table)路径与 `snip.rs` 共用同一 `fold_continuation_rows` 记录切分内核,故**随 P1 落地配置透传**(前端画出竖线即需正确取回合并列),不再悬空;持久化(P2)明确落盘位置后见下.

### 7.1 持久化模型(P2)

`GuidedMergeConfig` 属于**图片级操作集**而非全局偏好,不建议塞进 `AppSettings` 的 `paragraph_mode` 单枚举.P2 落盘方案: 

- **范围**: 跟随具体图片/截图会话的 OCR 请求,作为**无状态请求参数**传递(同现有 `ImageTableRequest.vertical_lines`);跨会话持久化按需再做(如需复用历史划线).
- **若需持久化**: 在 `AppSettings` 新增可选字段 `guided_merges: Vec<GuidedMergeConfig>`(`#[serde(default)]`),键为图片路径,读多写少、仅存用户显式保存的场景;不进入 `extract_cache` cache key(避免解密成本,与 00013 §6.1 一致).

## 8. 风险与开放问题

- 跨列文本行当前归入重叠最大的列(如整行表头会并入某一列),是否需要在 P2 支持按竖线物理切分文本;
- `mergeColumns` 仅折叠同记录内的折行、**不跨记录拼接**——若用户期望「某列多条记录整体合成一段」,当前不在 P0 支持,需确认后另立设计(§4.2 注);
- `guided` 与 draw-table 既有 `force_ocr` 流程的组合行为需回归验证;
- `mode = guided` 但未画竖线 / 未选合并列时的降级语义(当前定义为 `keep`)需在 UI 明确提示,避免用户误以为已合并;
- 竖线按全页高度处理,是否需要支持局部竖线(仅在某行带内生效)待用户反馈.
