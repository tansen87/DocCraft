# UI 现代化优化清单(Ui Modernization Pass)

状态:待评审
关联:[00002_settings-ui-redesign.md](./00002_settings-ui-redesign.md)、[00003_ui-ux-audit.md](./00003_ui-ux-audit.md)、[00006_liquid-dom-ui-migration.md](./00006_liquid-dom-ui-migration.md)(方案 C 已落地的 glass 语言)
范围:`src/views/*`、`src/components/**`、`src/index.css`、`src-tauri/tauri.conf.json`;**不动** Tauri 后端逻辑、snip 遮罩/结果窗的性能硬约束路径(见 00001/00005)。

---

## 1. 背景与目标

00006 方案 C 已把 liquid-glass 视觉语言落到现有栈(glass-panel / tokens / 头部毛玻璃),整体风格已经统一。本次走查聚焦"现代化"的剩余短板:**动效缺失、状态反馈粗糙、语义色不统一、可访问性欠账、排版层级扁平**。

原则:

- 全部用 CSS/Tailwind + 现有 shadcn 组件实现,**零新依赖**(不引入 framer-motion 等);
- 不触碰截图遮罩/结果窗的高帧路径;
- 每一项都可独立落地、独立验收。

---

## 2. P0 — 高收益低成本(建议第一批)

### 2.1 语义化状态色 token(消除散落的硬编码色)

现状:emerald/sky/amber/red 大量硬编码——StatusBadge 三份拷贝(`pdf-to-md.tsx:69-77`、`image-to-md.tsx:97-105`、`md-to-xlsx.tsx:55-63`)、通知等级(`status-bar.tsx:63-77`)、Switch 写死十六进制 `#54BD82` 等(`ui/switch.tsx:14`)。暗色模式下对比度不可控,主题调整需改 N 处。

方案:

1. `index.css` 新增语义 token(亮/暗各一套):
   ```css
   --success / --success-fg / --success-bg
   --warning / --warning-fg / --warning-bg
   --info    / --info-fg    / --info-bg
   ```
   并注册进 `@theme inline` 为 `--color-success` 等,Tailwind 直接写 `bg-success/10 text-success`。
2. 三份 StatusBadge 合并为 `components/ui/status-badge.tsx`,接收 `queued|running|done|error`,内部映射 token 色。
3. `ui/switch.tsx` 的 checked 色改为 `bg-primary`(或 `--success`),删除十六进制字面量。
4. pdf 类型徽标(`lib/pdf-meta.ts:16-31`)、通知等级、key-saved 徽章、更新徽章全部换用 token。

验收:全局搜索不到 `emerald-500|amber-500|sky-500|#54BD82` 等 UI 字面量;亮/暗两态目视对比度正常。

### 2.2 加载状态:骨架屏替代转圈

现状:`Loader2` 转圈 38 处;唯一的 Skeleton 在状态栏统计位(`status-bar.tsx:332+`);设置页加载只有裸 spinner(`settings.tsx:870`);`Progress` 组件存在但零使用。

方案:

1. 设置页加载时按最终布局渲染 Panel+SettingRow 形状的 Skeleton(3 组),替代居中 spinner。
2. PDF 预览加载时用页面形状的灰块(圆角矩形 × 可视页数)替代 spinner 文案(`pdf-preview.tsx:230-235`)。
3. 行内按钮级加载保留 spinner(正确用法),不加骨架。

验收:设置页与 PDF 预览首帧即有结构感,无 CLS 跳变。

---

## 3. P1 — 体验补强

### 3.1 排版与数字对齐

现状:全 app 收缩到 text-xs/sm 两档,信息层级靠颜色硬撑;`tabular-nums` 只有表格在用,摘要条/进度数字未用(markdown 正文固定 13px 属预览特性,不动)。

方案:

1. 定义两级标题规范:工具栏/面板标题 `text-sm font-medium`,区块标题维持 uppercase 小标签;不再新增 `text-[10px]`。
2. 所有计数、页码、百分比统一加 `tabular-nums`(摘要条、header 任务胶囊、状态栏)。

### 3.2 滚动条与溢出统一

现状:ScrollArea(Radix)与原生 `overflow-auto` 混用(App 容器、两个批量表格),滚动条观感不一致;无全局 `::-webkit-scrollbar` 样式。

方案:`index.css` 增加细滚动条样式(6px、透明轨道、`--border` 滑块、hover 加深),让原生溢出区域与 ScrollArea 观感一致;表格区继续保留原生滚动(性能优先)。

---

## 4. P2 — 较大改动(单独评审)

### 4.1 自定义标题栏

现状:主窗口仍是系统原生标题栏(`tauri.conf.json:13-20` 未设 `decorations: false`),应用头部在其下方,双栏 chrome 显得传统。

方案:`decorations:false` + 头部左侧加拖拽区(`data-tauri-drag-region`)+ 自绘最小化/最大化/关闭;头部已有毛玻璃语言可直接延伸。风险:多显示器/最大化 snap 行为、Windows 阴影与圆角需实测;建议独立 spike 后再排期。

### 4.2 小窗宽度适配打磨

现状:min 尺寸 800×600 下:hotkey 输入 `w-56`、notices 弹层 `w-96`、批量表固定列宽挤压文件名列(`pdf-to-md.tsx:551-559`)。

方案:固定宽改 `max-w-*` + 收缩策略;表格操作列改悬浮显示(hover 出现)释放横向空间。

---

## 5. 不做 / 维持现状

- markdown 预览 13px 正文字号(预览密度需求);
- 截图遮罩/结果窗的一切动效与模糊路径(性能硬约束,见 00001/00005/00006);
- WebGPU/liquid-dom 迁移(00006 结论:WebView2 环境阻塞);
- 引入动画库(tw-animate-css 足够)。

## 6. 实施顺序建议

| 批次 | 内容 | 预估 |
| --- | --- | --- |
| 1 | 2.1 动效 + 2.2 语义色 token(基建先行) | 0.5–1 天 |
| 2 | 2.3 空态 + 2.4 骨架屏 | 0.5 天 |
| 3 | 3.1–3.5 体验补强(可按项拆分并行) | 1–2 天 |
| 4 | 4.1 自定义标题栏 spike → 决策 | 单独 |

每批完成后跑 `pnpm exec tsc --noEmit` + 目视回归四个视图(亮/暗 × 中/英)。
