# DocCraft

[English](./README.md) | 简体中文

DocCraft 是一款跨平台的桌面转换工具,支持 **PDF → Markdown**、**Image → Markdown**、**Markdown → Excel**,并内置**截图 OCR**.本项目基于 [Tauri 2](https://tauri.app/)、React、TypeScript、[shadcn/ui](https://ui.shadcn.com/) 以及 [`pdf-inspector`](https://crates.io/crates/pdf-inspector)(Firecrawl 的纯 Rust PDF 分类/提取引擎)构建.界面支持双语---英语(默认)和简体中文,可在运行时切换.

> 详细架构与数据流文档: [docs/index.md](./docs/index.md)

## 核心亮点

- ⚡ **快速提取** --- 基于 `pdf-inspector` 的纯 Rust 文本层提取(无浏览器内核、无需联网),普通文本 PDF 毫秒级完成转换.
- ✏️ **划线提取** --- 在 PDF 页面或导入图片上绘制垂直/水平分隔线,按你划定的位置精确切分表格.
- 🧠 **智能文本合并** --- 可配置的段落合并策略(Guided / Smart / None),将换行的 OCR/文本行合并为连贯段落,同时保持表格、列表和标题结构完整.
- 🎯 **排除区域** --- 转换前在页面上框选页眉、水印、页码等区域,精准剔除不需要的内容.
- 📐 **Paddle 版面分析** --- 内置 **PP-DocLayoutV3** DETR 模型(MNN),还原 OCR 页面的阅读顺序,倾斜版面和多栏排版也能保持原始结构.
- 🔌 **离线 PaddleOCR** --- 内置本地 PaddleOCR 引擎(`ocr-rs`),全程在设备上运行: 扫描页识别零联网,数据不出本机.

## 截图

- ![pdf2md](./docs/img/pdf2md_draw-table.jpg)

  ![image2md](./docs/img/image2md.jpg)

  ![md2excel](./docs/img/md2excel.jpg)

  ![settings](./docs/img/settings.jpg)

## 功能特性

### PDF → Markdown

- **混合文本 + OCR**: 文本页面由 `pdf-inspector` 在本地提取;扫描版/纯图片页面渲染为 PNG 后发送至配置的 OCR 服务(远程 AI 视觉或本地 PaddleOCR),最后按文档顺序重组.
- **智能 PDF 路由**: 每个 PDF 都会被快速分类(约 10–50ms)为 `TextBased` / `Scanned` / `ImageBased` / `Mixed`,并精确列出需要 OCR 的页面.纯文本 PDF 无需联网.
- **离线 PaddleOCR**: 内置本地 PaddleOCR 引擎(`ocr-rs`),全程在设备上运行、无需联网;常驻引擎(可开关缓存)识别扫描页,并提供逐页置信度评分.
- **Paddle 版面分析**: 针对 OCR 页面,内置 **PP-DocLayoutV3** DETR 模型(MNN)检测区域结构与阅读顺序,多栏、倾斜的扫描件也能保持原始版面;模型缺失时优雅降级为纯 Y→X 排序.
- **排除区域**: 在页面上绘制矩形框,剔除页眉、水印、页码等干扰内容;支持逐页应用或一键应用到所有页面,直接转换和划线提取链路均生效.
- **智能文本合并**: 可配置的段落合并策略(**Guided** / **Smart** / **None**)决定提取行的拼接方式: 换行内容合并为连贯段落,表格、列表和标题保持完整.截图 OCR 结果遵循同一策略.
- **可配置 OCR 服务商**: 支持任何兼容 OpenAI chat-completions 的视觉 API(多厂商、多模型)或内置的本地 PaddleOCR 引擎.API 密钥静态加密存储(Windows 上使用 DPAPI),且不会暴露给前端.统一的 OCR 模式选择器提供五种选项: `ForceLocal`、`ForceAi`、`NonTextLocal`、`NonTextAi`、`Disabled`.
- **优雅的 OCR 降级处理**: 当没有可用的 OCR 服务时,转换仍可完成: 需要 OCR 的页面会被跳过并标记 `<!-- OCR skipped -->` 注释.单页失败则降级为 `<!-- OCR failed -->` 注释.状态栏中的铃铛图标会收集这些结构化通知,并提供可点击的页面标签和重试操作.
- **划线提取**: 在渲染的 PDF 页面上手动绘制垂直和水平分隔线以定义表格区域,然后将其提取为 Markdown.支持撤销/重做、逐页线条、“应用到所有页面”模式(可限制页数),以及针对扫描页面的 OCR 降级处理(本地 PaddleOCR 文本块分列切割,或带绘线提示的远程 AI 视觉).
- **批量队列**: 拖放多个 PDF,使用工作池进行转换,并发数可由用户配置(1–16),支持重试/移除/全部导出.
- **编辑器工作区**: 工具栏(转换)、分屏视图(PDF 预览 | Markdown 预览)、状态栏(类型/页数/置信度/OCR 需求/通知铃铛).

### Image → Markdown

- **专用工作区标签页**: 通过拖放或文件选择器接收 PNG/JPEG 图片,列表自动去重并显示缩略图.
- **OCR 识别**: 每张图片均由当前 OCR 模式选定的引擎(本地 PaddleOCR 或远程 AI 视觉)进行识别.
- **预览与导出**: 结果以合并后的 GFM 文档形式预览,支持单张导出或合并为一个 `.md` 文件.
- **图片画框提取**: 导入的图片可在画框叠加层中打开,绘制垂直线后,图片及线条位置将发送至后端进行分列提取(根据 OCR 模式,使用本地 PaddleOCR 文本块分列切割,或带线条提示的 AI 视觉).

### 截图 OCR

- 按下全局快捷键(默认 `F8`)或通过托盘菜单启动截图;每块显示器一个选区遮罩(带放大镜),可框选屏幕任意区域.
- 选定区域由当前 **OCR 模式**对应的引擎识别: 本地 PaddleOCR 使用截图专用引擎实例,不会排在批量任务之后排队等待;或发送至远程 AI 视觉.
- 识别结果遵循所选**段落合并策略**,并经过 OCR 文本清理(去除零宽字符、折叠空白、规范中英文间距).
- 识别结果显示在毛玻璃效果的结果窗口中,支持置顶、复制到剪贴板和关闭;可选自动复制、可调透明度,并会记住窗口位置.

### Markdown → Excel

- 拖放或选择 `.md` 文件;解析其中的 GitHub-Flavored Markdown 表格.
- 内联表格预览,显示表格/行数统计,支持单个或批量导出为 `.xlsx`.
- **可配置"仅表格"模式**: 开启时仅导出 GFM 表格;关闭时,整个文档内容写入工作簿.
- 可选**剥离 Markdown 语法**(`**加粗**`、`` `代码` ``、链接)与**数值单元格**: 数字导出为 Excel 数值类型,可直接排序和求和;代码围栏内的示例表格不会被误导出.
- 若表格由本应用的 PDF 转换生成,每个表格都会标注其源 PDF 页码(`Page N`).

### 性能与内存优化

- **逐页 OCR 流式传输**: 前端逐页渲染并上传;峰值内存占用仅为单页图片而非整个文档.
- **虚拟化 PDF 预览**: 仅渲染滚动视口附近的页面到 Canvas;屏幕外的位图会被释放.
- **懒加载 Markdown / Excel 预览**: 大文档采用分页渲染和窗口化行显示.
- **状态保持标签页**: 切换标签页时所有视图保持挂载(隐藏而非卸载),已加载的文件、结果和队列在切换后依然存在.

### 系统托盘

- 系统托盘图标,右键菜单包含“打开”、“开始截图”、“退出”,左键显示主窗口.
- 关闭按钮默认隐藏至托盘而非退出应用.可在设置中配置.

## 快速开始

**前置要求**: Node ≥ 20, pnpm ≥ 10, Rust ≥ 1.85.

```bash
pnpm install       # 安装前端依赖
pnpm tauri dev     # 运行桌面应用
pnpm tauri build   # 打包项目
```

常用检查命令: 

```bash
pnpm exec tsc --noEmit               # 前端类型检查
pnpm build                           # 前端生产构建
cargo check --manifest-path src-tauri/Cargo.toml  # Rust 代码检查
```

## 配置

- `ocr-config.json`: 每个供应商的名称、Base URL、受保护的 API Key、模型列表.
- `app-settings.json`: `maxConcurrent`(最大并发数)、`cacheExtractedText`(缓存提取文本)、`excelTablesOnly`(Excel 仅导出表格)、`stripMdSyntax`(剥离 Markdown 语法)、`writeNumeric`(数值单元格)、`ocrMode`(OCR 模式)、`screenshotHotkey`(截图快捷键)、`snipResultPopup`(截图结果弹窗)、`snipAutoCopy`(自动复制)、`snipResultOpacity`(结果窗透明度)、`enableTray`(启用托盘)、`textSeparator`(文本分隔符)、`paragraphMode`(段落合并策略)、`ocrTextCleanup`(OCR 文本清理)、`ocrLayoutMode`(版面分析模式)、`ocrLayoutModel`(版面分析模型)、`layoutScoreThreshold`(版面置信度阈值).

## 许可证

MIT