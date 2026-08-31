# PDF 换行策略(Line Break Mode)设计方案

状态:**已实施**(done,2026-08-31)  
实施说明:按本文档完成 P0 全部内容;D1 已确认默认 `smart`;D3(单文件级覆盖)按指示**不做**;  
`keep`/`smart`/`none` 三档已接入文本层与 OCR 两条通道,`extract_cache` cache key 保持不变。  
关联:`src-tauri/src/core/{convert,ocr,grid_rebuild,extract_cache,paragraph}.rs`、  
`src-tauri/src/{models,lib}.rs`、`src/views/settings.tsx`、`src/lib/types.ts`、  
`docs/design/00010_pdf-exclude-region.md`(两条通道的划分)、  
`docs/design/00009_feature-expansion-proposals.md`

---

## 0. 一句话结论

**不要做「换行 / 不换行」的布尔开关**,做成三档枚举 `keep | smart | none`,默认给 `smart`  
(**智能合并段落**)。理由是:用户真正想要的不是「去掉换行」,而是「**只去掉段落内部的软换行**」;  
纯粹的「不换行」会把表格、列表、诗歌、地址、合同条款全糊成一行,而布尔开关一旦落地就无法无痛扩展。

---

## 1. 需求

当前 PDF → Markdown 提取,**文本型页(有文本层)和非文本型页(扫描/OCR)都会逐视觉行硬换行**:

```
原文(一个自然段,排版时折了 3 行):
  本文档规定了XX系统的接口规范,适用于所有接入方。
  接入方应当在调用前完成鉴权,并妥善保管密钥。
  未按要求调用导致的损失由接入方自行承担。

当前输出(3 行硬换行):
  本文档规定了XX系统的接口规范,适用于所有接入方。
  接入方应当在调用前完成鉴权,并妥善保管密钥。
  未按要求调用导致的损失由接入方自行承担。
```

带来的问题:

| 下游场景             | 痛点                            |
| ---------------- | ----------------------------- |
| 粘贴到 Word / 飞书    | 每行末尾都是硬回车,重新排版后断句乱七八糟         |
| 喂给 LLM / 翻译      | 句子被打断,上下文碎片化,翻译质量下降           |
| Markdown → Excel | 一个段落被拆成多行单元格(`md_to_xlsx.rs`) |
| 全文检索 / 正则匹配      | 跨行的关键词匹配不到                    |
| 朗读 / 无障碍         | 每句都被切                         |

需求:提供设置让用户控制换行行为。

---


## 2. 现状:换行是哪里产生的

沿用 `00010` 里两条通道的划分:

```
通道 A(非文本型 / 需要 OCR 的页)
  前端 pdf.js 渲染 PNG → hybrid_page_ocr(sessionId, page, png)
    → A1 本地 PaddleOCR(ocr.rs:923 local_ocr_page)
        recognize_bytes_with_confidence(image, sep)
        —— 引擎按「检测到的文本框」逐行返回,行间固定 \n
    → A2 远端 AI Vision(ocr.rs:540 ocr_page,prompt = OCR_PROMPT:20)
        —— 视觉模型倾向还原页面视觉折行
                    ↓
通道 B(文本型 / 有文本层)
  pdf_inspector::extract_pages_markdown + extract_text_with_positions
    → grid_rebuild::rebuild_pages(grid_rebuild.rs:26)
        group_lines(:191) 按 y 聚成视觉行
        group_cells(:224) 行内按多空格切列
        lines_to_markdown(:253) 行内用 text_separator 连接,行间用 "\n" 连接  ← 换行在这里产生
                    ↓
  convert.rs:92 rebuild_document_for_pages / ocr.rs:950 finish_session 拼页
```

**关键坐标**:

| 环节                  | 位置                                                                         |
| ------------------- | -------------------------------------------------------------------------- |
| 行间 `\n`(通道 B 唯一产生点) | `src-tauri/src/core/grid_rebuild.rs:253-264` `lines_to_markdown`           |
| 视觉行聚类               | `src-tauri/src/core/grid_rebuild.rs:191-214` `group_lines`                 |
| 行内列切分               | `src-tauri/src/core/grid_rebuild.rs:224-242` `group_cells`                 |
| 本地 OCR 行输出          | `src-tauri/src/core/ocr.rs:923-947` `local_ocr_page`                       |
| AI OCR 提示词          | `src-tauri/src/core/ocr.rs:20` `OCR_PROMPT`(:24 用户自定义优先)                   |
| 逐页 OCR 结果入库         | `src-tauri/src/core/ocr.rs:851-917` `ocr_page_in_session`                  |
| 拼装(通道 A+B 汇合)       | `src-tauri/src/core/ocr.rs:950-990` `finish_session`                       |
| 本地转换拼装              | `src-tauri/src/core/convert.rs:92`                                         |
| 抽取缓存                | `src-tauri/src/core/extract_cache.rs:37-101`(cache key = path + separator) |
| 设置模型                | `src-tauri/src/models.rs:371-431` `AppSettings`(:751-772 Default)          |
| IPC 命令              | `src-tauri/src/lib.rs:105-141`                                             |

结论:**两条通道的换行来源不同,但都发生在「得到每页的 markdown 字符串之后、拼页之前」**,  
这给统一后处理留出了干净的切入点。

---

## 3. 建议方案:三档枚举,而不是布尔开关

### 3.1 为什么不建议「换行 / 不换行」布尔值

1. **布尔值无法扩展。** 现在只要两个值,下个月用户会要「只合并段落、保留列表」,布尔值就得做  
   数据迁移;枚举加一个 variant 则是无感的。
2. **纯「不换行」几乎总是错的。** 以下内容的换行是**硬换行**,必须保留:
   - GFM 表格(整页表格会被压成一行,直接毁掉 `md_to_xlsx` 导出)
   - 列表项 / 编号条款(合同里的 `1.1` / `(二)`)
   - 标题、代码块、诗歌、地址块、表格化的键值行
3. **用户表达的「不换行」= 「段落内不要换行」。** 这是两个不同的需求,应该分开表达。

### 3.2 三档定义

| 值       | UI 文案            | 行为                                  | 适用               |
| ------- | ---------------- | ----------------------------------- | ---------------- |
| `keep`  | 逐行保留(原始)         | **现状**,一个视觉行 = 一个 Markdown 行        | 表格密集、代码清单、诗歌、地址簿 |
| `smart` | 智能合并段落(**推荐默认**) | 只合并「同一个段落内部的软换行」,段落边界、表格、列表、标题处保留换行 | 绝大多数文档           |
| `none`  | 整段不换行            | 页面内所有软/硬换行都合并成一行(表格、代码块仍跳过)         | 纯正文扫描件、要灌进向量库的语料 |

- `keep` 保持字节级与当前一致 → 老用户零回归。
- `smart` 是推荐默认:它解决的正是「段落被折断」的痛点,同时不破坏结构。
- `none` 兜住「我就是要一整坨文本」的极端场景,成本几乎为零(复用 `smart` 的判定,只是忽略边界结果)。

### 3.3 默认值决策(已确认:默认 `smart`,对应 §11 D1)

建议**默认 `smart`**。这是一次行为变更,需要在 changelog 里写明,并且:

- 已经在用批量转换做 Excel 导出的用户,输出行数会变少(段落变长)→ 需要回归 `md_to_xlsx`。
- 若担心回归,可先默认 `keep` 跑一个版本收集反馈,再切到 `smart`。

---

## 4. 判定算法:哪些换行该合并

输入:一页的若干内容行 `L[0..n)` + (通道 B 可用)每行的几何元数据。  
对每一对相邻非空行 `L[i-1] → L[i]`,先判「**不可合并**」(硬换行),命中任一即断开;  
否则合并。采用**白名单式合并(默认断开)**&#x504F;保守更好,但会让 `smart` 效果打折;  
这里采用**黑名单式合并(默认合并)+ 多重硬换行信号**,因为绝大多数文档里软换行占多数。

### 4.1 全局短路(整个页面/整个块跳过)

命中任一 → 该页(或该块)整体 `keep`,一行不动:

- **G0-a 表格页**:页内含 GFM 分隔行(`^\s*\|?[\s:-]*-{3,}`)或 ≥50% 行以 `|` 开头/结尾。  
  另外 `FullExtraction.pages_with_tables` 已有的页也直接跳过。
- **G0-b 多栏页**:`FullExtraction.pages_with_columns`(`extract_cache.rs:17`)命中的页 → 回退 `keep`。  
  **重要**,多栏排版里两栏内容在阅读顺序上交错,行合并会把左右栏首尾接成一句。
- **G0-c 代码块**:处于 ` ``` ` / `~~~` 围栏内的行,原样保留。
- **G0-d OCR 页**:`page.needs_ocr == true` 的页在通道 B 里是原样 markdown(AI 输出),  
  不做几何判定,走 §4.3 文本启发式。

### 4.2 通道 B(文本层)的几何信号 —— 主力

在 `group_lines` 阶段顺带产出每行的 `LineMeta { y, font_size, x0, x1 }`  
(见 §6)。设 `line_height = font_size * 1.2`,`block_left / text_width` 取本页所有行的  
`min(x0)` 与 `max(x1) - min(x0)`(自足估算,不必引入页面尺寸)。

**判定为「硬换行 / 新段落」(任一命中即断开)**:

| 编号 | 信号       | 判据                                                                                                                   |                               |                         |
| -- | -------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------- |
| G1 | 段间距      | `y[i-1] - y[i] > line_height * 0.75`(正常行距约 `line_height * 0.2~0.5`)——**实现注**:PDF 实际行距约等于 `line_height`,按文档阈值会把常规行误判为断段,故代码取 `1.5 × line_height` |                               |                         |
| G2 | 首行缩进     | `x0[i] - block_left > font_size * 1.5`(中文 2 字符缩进 ≈ `2 * font_size`)且 `x0[i-1] - block_left < font_size * 0.5`(上一行顶格) |                               |                         |
| G3 | 上段收尾短行   | `(x1[i-1] - block_left) < text_width * 0.6` 且当前行顶格 → 上一段结束                                                           |                               |                         |
| G4 | 字号变化     | \`                                                                                                                   | font_size[i] - font_size[i-1] | > 0.5\` → 块边界(标题/引用/注释) |
| G5 | 列表/编号起头  | 见 §4.4 `starts_block_marker()`                                                                                       |                               |                         |
| G6 | 上一段以句号结尾 | **实现注:几何路径已移除该信号**(中文段内句子常以句号结尾,会误断段);仅保留在 §4.3 文本启发式 T1 中,作为 OCR 页(无几何)的兜底                   |                               |                         |

**判定为「必须合并」(优先级高于上面的断开判定)**:

| 编号 | 信号   | 判据                                                         |
| -- | ---- | ---------------------------------------------------------- |
| G7 | 英文断词 | 上一行以 `-` 结尾,且 `-` 前是 ASCII 字母、下一行以小写 ASCII 字母开头 → 去连字符直接拼接 |
| G8 | 列内折行 | 当前行缩进 ≥ `3.5 × font_size`(列位,而非 2 字符的首行缩进)且 `x0[i] ≤ x1[i-1] + font_size * 0.5`(上一行已经写到该列)→ 这是上一行该列被折下来的余下内容,**必须并回上一行** |

G7 优先于 G1/G4:断词处的行距/字号偶尔会有微小抖动。  
G8 优先于 G2:没有它,G2 会把「折到第 2 列的行」当成「新段落的首行缩进」,
于是 `smart` 在多列表格上退化成 `keep`(见 §4.5)。

**列布局下追加的断开判定(G9)**:

| 编号 | 信号      | 判据                                                                                          |
| -- | ------- | ------------------------------------------------------------------------------------------- |
| G9 | 列布局新记录行 | 本页存在任一 G8 续行(`PageGeom::column_layout == true`)且当前行顶格(`x0[i] - block_left < font_size * 0.5`)→ 新的一行记录,断开 |

G9 只要求**当前行**顶格:上一行可能是上一条记录被折下来的列内续行,本身并不顶格。  
没有 G9,几何完全相同的表头行与数据行会被并成一行。

### 4.3 通道 A(OCR 页)的文本启发式 —— 没有几何,只能靠文本

本地 PaddleOCR 与 AI Vision 的输出都只有字符串(行)。用下列信号:

**断开(硬换行)**:

- **T1** 上一行以句末标点结尾:`。！？…;；` 或 `.!?` (`.` 需满足:后跟行尾或空格,且前一字符不是单字母缩写/数字序号)
- **T2** 当前行以缩进开头:行首 ≥2 个半角空格或 ≥1 个全角空格
- **T3** 当前行以块标记开头(见 §4.4)
- **T4** 上一行是短行:长度 < 本页中位行长的 50%,且不以句末标点结尾(标题/小标题/图注)
- **T5** 上一行以冒号 `:`/`：` 结尾(引出一个列表或子条款)
- **T6** 上一行或当前行是 GFM 表格行 / 围栏行

**合并**:其余情况一律合并(扫描件正文绝大多数是软折行)。

### 4.4 共用的文本谓词(放进新模块,可被两条通道复用)

````rust
/// 行首是否是列表项 / 编号 / 条款标记 → 新块,不合并
fn starts_block_marker(line: &str) -> bool {
  // 无序: - • * ·  ○ ■  ▪
  // 有序: 1. 1) (1) ① 一、 （一） 第一章  第1条  1.1  A.
  // 引用: >    表格: |    围栏: ```
}
/// 上一行是否以句末标点收尾 → 段落结束
fn ends_sentence(line: &str) -> bool { /* 。！？… 」』"' )  | . ! ? */ }
/// 是否 CJK 字符(决定是否加空格,见 §5)
fn is_cjk(c: char) -> bool { /* U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF,
                                 U+3040-30FF, U+AC00-D7AF, U+3000-303F, U+FF00-FF60 */ }
````

### 4.5 列布局(无边框表格)为什么需要 G8/G9

无边框表格在 PDF 里是「每行一个逻辑记录、记录内某列因列宽不够而折行」:

```
idx   desc              ← 逻辑行 1(表头)
1     this              ← 逻辑行 2:id=1,desc 从第 2 列开始
      is                ← 第 2 列被折下来的余下内容
      test              ← 同上
```

提取器按视觉行输出,得到 `idx,desc / 1,this / is / test`。期望的智能合并结果:

```
idx,desc
1,this is test
```

难点在于 G8 与 G2 长得一模一样——都是「当前行比上一行靠右」,只能靠**缩进量级**区分:
中文首行缩进是 2 字符(≈`2 × font_size`)、英文约 0.5in(12pt 字体下 ≈`3 × font_size`),
而列间距一定更宽,故取 `3.5 × font_size` 作为分界。

G8/G9 只在**通道 B(文本层)**生效,且只作用于 `pages_with_tables` / `is_table_page`
**没有**命中的页:

- **OCR 页**(扫描件)没有 `LineMeta`,拿不到列位,走 §4.3 文本启发式兜底。
- **被判定为 GFM 表格的页**走 §4.1 的 G0-a 整页短路,输出保持 `| a | b |` 原样 ——
  这是刻意保护:在 **Markdown 文本层面**合并表格行会直接毁掉 GFM 结构和 Excel 导出。

### 4.6 划线表格(line-draw):在**表格构建阶段**合并单元格内折行

§4.5 的短路只保护 Markdown 文本,但**划线提取的表格**恰恰需要「单元格内部折行合并成一行」——
用户画竖线就是想让某一列的内容归到同一个格子里。这个诉求必须在
**`MdTable` 层面**(还没有变成 `| a | b |` 文本之前)解决 —— 也就是在
`line_draw.rs` 构建表格时做,而不是事后去解析 GFM 文本再合并(那正是 G0-a 要防的事)。

三条划线路径的现状与处置:

| 路径                                      | 折行单元能否合并 | 处置                                            |
| --------------------------------------- | -------- | --------------------------------------------- |
| 横线 + 竖线(grid)                          | **原本就能** | 已按 row band 分桶,同 band 内多视觉行自动拼进同一单元格;只把连接符从 `join(" ")` 换成 `paragraph::join_fragments()`(CJK 不留空格) |
| **只有竖线**(无横线,自动分行)                   | **不能**  | 新增续行折叠(`merge_continuation_rows`),本次修复的核心                  |
| 矩形框选(legacy,前端已不发送 `rectangles`)      | 不适用      | 保持原样,不接入                                       |

**续行判据**(`is_continuation`,窄口径,宁可不并也不错并):

设 `c` = 当前视觉行第一个非空单元格的列号,`p` = 上一条记录**最后一个视觉行**的第一个非空列号。

1. `c == 0` → 顶格,**新记录**,从不合并;
2. `p < c` 且 `c > 0` 且 `p 那一行在第 c 列有内容` → 折下来的余下内容,**合并**;
3. `p == c` 且 `c > 0` 且上一条视觉行**已被认定为续行** → 折行链的第二行及以后,**合并**;
   (要求「上一条是续行」是关键:否则「第一列永远为空的表格」会被整张并成一行)
4. 上下间距 > `2.5 × font_size`(`ROW_GAP_EM`)→ 视为分段,**强制新记录**,不受上面三条影响;
5. 整行无内容 → 直接丢弃,既不开始记录也不并入。

规则 2 要求「上方同列有内容」,保证续行一定是接在**确实写了东西**的格子上,
而不是接在一个空洞上。

`keep` 档直接跳过整个折叠(每个视觉行一行,行为与本次改动前完全一致),
`smart` / `none` 档启用折叠 —— 表格场景下 `none` 不做「整页并成一行」,
那会毁掉表格结构,两档在此表现一致。

---

## 5. 合并时用什么连接(最容易做错的一处)

**中文之间不加空格,中英/英英之间加一个空格。** 这是中文文档处理的硬规则,做反了  
整篇文档会变成「本 文 档 规 定 了」或者「本文档规定了XXand。

```rust
fn connector(prev: &str, next: &str) -> &'static str {
  // 1) 英文断词: "inter-" + "national" → "international"(无连接符)
  // 2) 上一行已以空白结尾 / 下一行已以空白开头 → 不再补
  // 3) prev 末字符与 next 首字符都是 CJK → ""
  // 4) 否则 → " "
}
```

**与 `text_separator`(文本连接符)的关系**:`text_separator` 是**行内**列与列的连接符  
(`grid_rebuild.rs:253`),**不参与行间合并**。行间连接一律走上面的自动推断。  
这条要在 UI 上写清楚,否则用户会以为设置了 `|` 就应该用 `|` 接行。

---

## 6. 架构落地:把合并做成「缓存之后的纯后处理」

### 6.1 关键决策:**不进 `extract_cache` 的 cache key**

`extract_cache::cached_extraction` 目前以 `path + separator` 为 key(`extract_cache.rs:37-41`)。  
如果把 `paragraph_mode` 也加进 key,用户每切一次档就要整本重新解码 PDF(字体 CMap + 内容流),  
代价极大,而且批量转换时缓存槽会疯狂抖动。

**做法**:缓存里存**规范形态**(逐视觉行的 `page_markdowns`,与现状一致),  
外加一份轻量几何元数据;合并策略在取出缓存**之后**再施加。这样切换档位零重解码成本。

### 6.2 `LineMeta` 随 `group_lines` 一起产出

`grid_rebuild.rs` 的 `group_lines`(:191)已经把 `TextItem` 聚成视觉行了,顺手产出元数据:

```rust
/// 一行视觉行在页面中的几何信息(供段落合并判定用)。
#[derive(Debug, Clone, Copy)]
pub struct LineMeta {
  pub y: f32,          // PDF 用户空间(原点左下)
  pub font_size: f32,  // 该行字号,用于估算行高
  pub x0: f32,         // 行最左端
  pub x1: f32,         // 行最右端(x + width)
}
```

改动点:

- `group_lines` → `group_lines_with_meta`,返回 `(Vec<Vec<&TextItem>>, Vec<LineMeta>)`;
- `group_cells` / `lines_to_markdown` → 增加 `_with_meta` 变体,返回 `(String, Vec<LineMeta>)`。  
  **注意对齐**:`lines_to_markdown` 会跳过空行(`grid_rebuild.rs:237`),所以 meta 必须  
  **只 push 非空行**,保证 `markdown.lines().nth(i)` 与 `meta[i]` 一一对应;
- `rebuild_pages`(:26)返回 `Vec<PageText>`,其中 `PageText { markdown, lines, has_geometry }`;  
  表格页 / `needs_ocr` 页的 `lines` 为空、`has_geometry = false`(走文本启发式);
- `rebuild_pages_excluding`(:69)同步改造 —— **被排除区域重建过的页必须重算 meta**,  
  否则残留的旧 meta 会指向已删除的行。

### 6.3 `FullExtraction` 增加一个字段

```rust
// extract_cache.rs:8
pub struct FullExtraction {
  // ...
  /// 每页每行的几何信息,与 `page_markdowns` 平行;表格页 / OCR 页为空。
  pub line_meta: Vec<Vec<LineMeta>>,
}
```

内存开销:每视觉行 ~16 字节,一本 500 页 × 40 行的书 ≈ 320 KB,可忽略。  
`cached_extraction` 的签名与 cache key **保持不变**。

### 6.4 新模块 `src-tauri/src/core/paragraph.rs`

```rust
pub enum ParagraphMode { Keep, Smart, None }

/// 对逐页 markdown 施加换行策略。纯字符串 → 字符串,不触碰 PDF。
/// `line_meta` 为 `Some` 时走几何判定(通道 B),为 `None` 时走文本启发式(通道 A)。
pub fn apply(
  pages: &[String],
  meta: Option<&[Vec<LineMeta>]>,
  pages_with_tables: &[u32],
  pages_with_columns: &[u32],
  mode: ParagraphMode,
) -> Vec<String>;
```

调用点:

| 通道                     | 位置                                                                                | 说明                                                         |
| ---------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| B(本地转换)                | `convert.rs:92` 之前                                                                | `grid_rebuild::apply(...)` 后再 `rebuild_document_for_pages` |
| B(hybrid session 的文本页) | `ocr.rs:678-850` `start_session` 内,排除区域处理完之后                                      | 与 `pages_with_columns` 一起即可拿到                              |
| A-1 本地 OCR             | `ocr.rs:923-947` `local_ocr_page` 返回前                                             | 只有字符串,传 `meta = None`                                      |
| A-2 AI Vision          | 两处:① `ocr.rs:20` `OCR_PROMPT` 追加一句「同一段落的换行请合并为一行,不要还原页面折行」;② 结果回来后仍走一次 `apply` 兜底 | 用户自定义 `ai_ocr_prompt` 时 **不覆盖**,只在内置默认 prompt 上追加          |
| 拼装                     | `ocr.rs:950` `finish_session`                                                     | **不改**,因为各页在进入 session 前已处理完                               |

**注意**:`apply` 放在逐页结果入库前(而不是 `finish_session` 里)的好处是,  
前端逐页预览/进度里看到的就是合并后的结果,和最终文档一致。

### 6.5 明确不接入的地方

- `line_draw.rs` 输出的 **Markdown 文本**:表格结构优先,在文本层面合并会毁表 → 跳过
  (G0-a 保护)。但**表格构建阶段**按 §4.6 合并单元格内折行 —— 那是 `MdTable`
  层面,不是文本层面,两者不冲突。
- `md_to_xlsx.rs`:不改,但需要回归测试(见 §9 R4)。

### 6.6 划线表格的接入点

`paragraph::apply` 处理不了表格(见 §6.5),所以划线表格走单独的一条链,
但仍然由同一个 `ParagraphMode` 开关控制:

| 位置                                              | 改动                                                    |
| ----------------------------------------------- | ----------------------------------------------------- |
| `line_draw.rs::extract_table_from_vertical_lines` | 新增 `mode` 参数;视觉行先切成 `VisualRow`(带 y / font_size),再过 `merge_continuation_rows` |
| `line_draw.rs::extract_table_from_grid`          | 单元格内多视觉行的连接符由 `join(" ")` 换成 `paragraph::join_fragments()` |
| `line_draw.rs::extract_table_from_rectangle`     | legacy,前端已不发送 `rectangles`,不接入                        |
| `extract_tables_from_draw_lines` / `_and_merge`   | 透传 `paragraph_mode`                                   |
| `lib.rs::extract_draw_table` / `…_to_markdown`    | 从 `settings.paragraph_mode` 取值传入                      |
| `ocr.rs::DRAW_TABLE_PROMPT`                      | 追加「单元格内折行合并成一行,CJK 之间不加空格」,覆盖扫描件走 AI 视觉的路径      |

---

## 7. 设置模型与兼容性


### 7.1 后端

```rust
// models.rs —— 新增
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ParagraphMode {
  /// 逐行保留(旧行为)。
  Keep,
  /// 智能合并段落内软换行。**默认值**,见 §11 D1。
  #[default]
  Smart,
  /// 整页不换行(表格/代码块除外)。
  None,
}
```

`#[default]` 落在 `Smart` 上这一步很关键:`app-settings.json` 缺字段时(新用户、
旧版本配置)走的是 `ParagraphMode::default()`,若它是 `Keep`,后端实际生效档位
就会和前端兜底的 `"smart"` 不一致。

反序列化容错(`app-settings.json` 是用户可编辑的、也会跨版本导入):

```rust
// models.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "String")]
pub enum ParagraphMode { /* ... */ }

impl TryFrom<String> for ParagraphMode {
  type Error = std::convert::Infallible;
  fn try_from(s: String) -> Result<Self, Self::Error> {
    Ok(match s.trim().to_ascii_lowercase().as_str() {
      "smart" | "unwrap" | "paragraph" => Self::Smart,
      "none"  | "single" | "nolinebreak" => Self::None,
      _ => Self::Keep,   // 未知值 / 旧配置 → 回落到现状,绝不因配置损坏而崩
    })
  }
}
```

`AppSettings`(`models.rs:371`)新增:

```rust
/// 段落换行策略:文本层页与 OCR 页共用的行合并方式。
#[serde(default)]
pub paragraph_mode: ParagraphMode,
```

`settings.rs::clamp_settings`(:148)无需 clamp。  
`config_transfer.rs` **无需改动** —— `AppSettings` 整体序列化,新字段有 `#[serde(default)]`,  
旧版本导出的配置文件导入后自动回落 `Keep`;`EXPORT_VERSION` 保持 `1`。

### 7.2 前端

| 文件                               | 改动                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/lib/types.ts:119`           | 新增 `paragraphMode?: ParagraphMode`(导出同名类型,可选以兼容旧 IPC)                                                                  |
| `src/i18n/translations.ts:515`   | 新增 `settings.lineBreak` / `settings.lineBreakDesc` 及三档选项文案(中英双语)                                                       |
| `src/views/settings.tsx:99-126`  | **扩展现有 `textSep` 分组**:标题 `settings.textSeparator` 改为「文本与换行」,把换行策略放在 `textSeparator` 正上方 —— 两者是同一类关注点(文本如何拼接),放一起用户才找得到 |
| `src/views/settings.tsx:192-228` | 新增 `paragraphMode` state + 初始化 + save payload                                                                          |
| 其他 IPC                           | `get_app_settings` / `set_app_settings` 走的是整个 `AppSettings`,**命令签名不变**                                                 |

UI 形态建议:使用select,参考识别模型。

---

## 8. 边界与风险

| 编号 | 风险                                        | 处置                                                                           |            |
| -- | ----------------------------------------- | ---------------------------------------------------------------------------- | ---------- |
| R1 | **表格被合并**,直接毁掉 GFM 表格和 Excel 导出           | §4.1 G0-a 整页短路;`pages_with_tables` 也跳过;\`                                    | \` 开头行永不合并 |
| R2 | **多栏排版首尾错接**                              | G0-b:命中的页整页回退 `keep`                                                         |            |
| R3 | 页眉/页脚被并进正文第一段                             | P0 依赖已有的 exclude-region(`docs/design/00010`);P2 再考虑「多页重复出现且位于页面上下 8% 的行」自动识别 |            |
| R4 | **Markdown → Excel 输出结构变化**               | 段落变长、行数变少;`md_to_xlsx` 需回归,尤其是「非表格内容」的写入分支                                   |            |
| R5 | 诗歌/地址/代码清单被误合并                            | 依赖 G4(字号)、G5(编号)、T2(缩进)、T4(短行)信号;`keep` 档位兜底                                 |            |
| R6 | AI Vision 输出本身就带 Markdown 结构              | `strip_markdown_fence`(ocr.rs:374)之后再做;`apply` 对 `\|` / `#` / `>` / 围栏行一律不合并 |            |
| R7 | `smart` 默认导致老用户批量转换结果突变                   | §3.3 D1;changelog 明确标注"行为变更";`keep` 永久保留                                     |            |
| R8 | `lines_to_markdown` 跳过空行导致 meta 错位        | §6.2:meta 只 push 非空行,并加单测断言 `markdown.lines().count() == meta.len()`         |            |
| R9 | `rebuild_pages_excluding` 后 meta 与重建内容不一致 | §6.2:排除页一律重算 meta                                                            |            |

---

## 9. 分阶段实施

**P0(已全部完成 ✅)**

1. ~~`models.rs` 新增 `ParagraphMode` + `AppSettings.paragraph_mode`(默认 `smart`,待 D1 确认)~~ → **done**,默认 `smart`;

2. ~~`grid_rebuild.rs`:`group_lines_with_meta` / `lines_to_markdown_with_meta` /  

   ~~`rebuild_pages` 返回 `PageText`;`rebuild_pages_excluding` 同步~~ → **done**;

3. ~~`extract_cache.rs`:`FullExtraction.line_meta`,cache key 不变~~ → **done**;

4. ~~新模块 `core/paragraph.rs`:`apply()` + 几何信号(G1–G9)+ 文本信号(T1–T6)+ `connector()`~~ → **done**(G1 阈值按实现定为 1.5×line_height,几何模式移除 G6,见 §4 注;G8/G9 为列布局补增,见 §4.5);

5. ~~接入 `convert.rs:92`、`ocr.rs::start_session`、`ocr.rs::local_ocr_page`~~ → **done**(另含 `ocr_page_in_session` 与 `convert_image_to_md`);

6. ~~`OCR_PROMPT` 追加段落合并指令~~ → **done**;

7. ~~前端:`types.ts` / `translations.ts` / `settings.tsx`~~ → **done**(设置页"文本与换行"分组新增三档选择器);

8. ~~单测 + 手工验收清单(§11)~~ → **done**:`paragraph.rs` 16 个单测,`cargo test --lib` 85 个全部通过,前端 `tsc --noEmit` 通过;

9. ~~划线表格(`line_draw.rs`)接入同一开关~~ → **done**(§4.6 / §6.6):只有竖线的路径新增
   续行折叠,grid 路径换用 `join_fragments()`,`DRAW_TABLE_PROMPT` 追加合并指令;
   `cargo test --lib` 91 个全部通过。

**P1**  

10\. ~~`none` 档位细化 + 转换工具栏单文件覆盖(§8)~~ → `none` 档已随 P0 完成;**单文件覆盖按用户指示不做**(D3 关闭);  

**P2(可选)**  

11\. 截图识别(`snip.rs:325,478`)是否接入同策略 - 截图场景多数希望合并,但保留原样也有用例,需单独评估;  

12\. 英文断词词典(避免 `co-op` 之类被误 de-hyphenate)。

---

## 10. 测试与验收

### 10.1 单测(新模块 `paragraph.rs`)

- 中文三行一段 → `smart` 下合并成 1 行,**且行间无空格**;
- 英文软折行 → 合并后补 1 个空格;`inter-\nnational` → `international`(无空格、无连字符);
- 段落间距(G1)大于阈值 → 不合并;
- 首行缩进 2 字符(G2)→ 不合并;
- GFM 表格页 → 一行不动;
- `pages_with_columns` 命中的页 → 一行不动;
- 列表项 / `1.1` 条款 / `一、` / `>` 引用 → 不合并;
- 代码块围栏内 → 不合并;
- `keep` 档 → 输出与输入**字节相同**;
- `none` 档 → 表格页仍保持原样;
- 未知配置值 `"weird"` → 回落 `Keep`,不 panic;
- **列内折行(G8)**:两列布局中第 2 列折下来的行并回上一行 → `idx,desc / 1,this / is / test`
  变成 `idx,desc / 1,this is test`;
- **列布局新记录(G9)**:相邻两条记录各自的折行只并入自己的记录,
  `1,this is / tail one / 2,this is / tail two` → `1,this is tail one / 2,this is tail two`;
- **G8 不误伤**:缩进很大但上一行根本没写到那个 x 的行,不是列延续,仍按 G2 断开;
- **G9 不误伤**:没有列内折行的纯段落页,顶格行照旧合并成一段。

### 10.1b 单测(划线表格 `line_draw.rs`)

- **只有竖线 + 单元格折行**:`idx,desc / 1,this / is / test` 在 `smart` 下 →
  表头 `idx | desc`,数据行 `1 | this is test`(1 行);
- **同一场景 `keep` 档**:仍是 3 个数据行 `1|this` / `(空)|is` / `(空)|test`,与改动前一致;
- **不串记录**:折行后再来一条顶格记录 `2 | that`,两条记录互不吞并;
- **间距保护**:折行块下方很远处的缩进行,按分段处理,不并入上一条记录;
- **CJK 不留空格**:中文单元格折行 `这是 / 一段 / 说明` → `这是一段说明`;
- **第一列恒空的表格**:没有顶格锚点时,各行保持独立,不会整表并成一行;
- **grid 模式**:表头 band 内两行中文 → `表头跨带`(CJK 无连接空格)。

### 10.2 集成断言

- `markdown.lines().count() == line_meta.len()`(所有非表格、非 OCR 页);
- 切换 `paragraph_mode` 后**不触发重新解码**:断言 `cached_extraction` 命中缓存(cache key 未变)。

### 10.3 手工验收清单

| 文档类型     | 期望                        |
| -------- | ------------------------- |
| 中文论文(双栏) | 多栏页保持逐行;单栏页段落合并正确         |
| 合同扫描件    | 条款编号不丢,条款内折行合并            |
| 财务报表 PDF | 表格 100% 保持,Excel 导出与现在一致  |
| 中英混排技术手册 | 中文无缝、英文补空格、断词还原           |
| 带页眉页脚的书籍 | 配合 exclude-region 后正文段落干净 |
| 纯文字扫描书   | `none` 档下一页一坨,灌向量库可直接用    |
| 划线提取表格   | 只有竖线时,列内折行合并进同一单元格;切到 `keep` 立即恢复逐视觉行 |

---

## 11. 待决策(已全部决策)

| 编号 | 决策点                                                  | 结论                                                            |
| -- | ---------------------------------------------------- | -------------------------------------------------------------- |
| D1 | 默认档位取 `keep` 还是 `smart`?                             | ✅ 已决策:**`smart`**(用户指示"D1默认值为smart")                             |
| D2 | 是否把 `paragraph_mode` 纳入 `extract_cache` 的 cache key? | ✅ 已决策:**否**,走缓存后处理(§6.1)已实现,cache key 保持 `path + separator` |
| D3 | 是否提供单文件级快速覆盖(§8)?                                    | ✅ 已决策:**不做**(用户指示"D8不需要")                                     |
| D4 | 截图识别是否同步接入?                                          | ⏸ 未做,仍按 P2 单独立项评估                                              |
| D5 | `none` 档是否也保留段落之间的空行?                                | ✅ 已实现:空行视为结构边界不参与合并,只合并非空行;表格/围栏/多栏页保持原样          |
| D6 | 划线表格是否也受 `paragraph_mode` 控制?                        | ✅ 已决策:**受控**,但在 `MdTable` 层面做(§4.6),不在 Markdown 文本层面做;`none` 档在表格内与 `smart` 表现一致,不做整表合并 |

---

## 12. 附:`smart` 模式伪代码

```rust
fn join_page(lines: &[String], meta: Option<&[LineMeta]>, mode: Mode) -> String {
  if mode == Keep { return lines.join("\n"); }
  if is_table_page(lines) || in_columns_page() { return lines.join("\n"); }

  let mut out: Vec<String> = Vec::new();
  let mut fence = false;
  for (i, line) in lines.iter().enumerate() {
    toggle_fence(&mut fence, line);
    if out.is_empty() || line.trim().is_empty() || fence { out.push(line.clone()); continue; }

    let hard = if mode == None {
      false                                   // none: 一律合并
    } else if let Some(m) = meta {
      hard_break_geometric(m, i)              // G1–G6, G7 优先否决
    } else {
      hard_break_textual(&out[out.len()-1], line)  // T1–T6
    };

    if hard { out.push(line.clone()); }
    else {
      let c = connector(out.last().unwrap(), line);
      let merged = format!("{}{}{}", out.pop().unwrap(), c, line);
      out.push(merged);
    }
  }
  out.join("\n")
}
```
