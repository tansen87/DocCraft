# 引入 liquid-dom 重构 UI 的设计方案

状态:待评审(含可行性门槛,建议先 P0 原型验证再决策)
关联:`liquid-dom.md`(依赖文档)、`src/App.tsx`(应用外壳)、`src/components/ui/*`(shadcn 基础件)、`src/views/*`(四个工作区视图)、`docs/index.md`

---

## 1. 背景与目标

当前 UI 基于 **shadcn/ui(Radix)+ Tailwind v4 design tokens + next-themes 深色模式**。
视觉上已经是"圆角卡片 + 发丝线 + 毛玻璃(仅截图结果窗用 CSS backdrop-blur)"的桌面风格,
但整体仍是传统 DOM 排版,没有原生 GPU 合成、也没有 fluid 的动态玻璃过渡。

`@liquid-dom/react`(v0.1.1,可安装)提供 **基于 WebGPU 的 liquid-glass 布局/玻璃渲染** 能力:

- 布局节点(`Frame/HStack/VStack/...`)在渲染期间由渲染器直接 mutate,React 只做描述;
- `GlassContainer + Glass + Html` 组合实现真正的 GPU 玻璃(hue-blur / refraction / specular / shadow);
- 支持 `transition`/`spring`/`easing` 声明式动画、`useFrame` 帧循环、`LiquidCanvas` 根。

目标:评估能否用 liquid-dom 替换现有 DOM UI,若可行则给出迁移方案;若不可行,则如实给出**门槛结论**与替代路线,避免投入错误方向。

---

## 2. 现状技术栈盘点(迁移范围)

| 层 | 现状 | 迁移影响面 |
| --- | --- | --- |
| 应用外壳 | `App.tsx` 四个 tab + 常驻挂载(hidden)保持状态 | 中 |
| 头部 | `layout/app-header.tsx`,Tabs 导航 + 任务胶囊 + HeaderActions/语言/主题切换 | 中 |
| 基础组件 | `components/ui/*` 19 个(shadcn/Radix:button/card/dialog/select/switch/tabs/tooltip/dropdown/input 等) | 大 |
| 视图 | `views/*` 4 个(pdf-to-md / image-to-md / md-to-xlsx / settings)| 很大 |
| 辅助视图 | snip 结果窗/截图遮罩(`snip-overlay`、`snip-result-window`) | 特殊(透明独立窗口 + 高帧约束) |
| 数据密集型内容 | pdf.js 渲染、markdown 预览、表格编辑、拖拽、跨窗口 IPC | 强依赖真实 DOM |
| 样式基座 | `index.css`(tokens + `@layer base`)、`tw-animate-css` | 保留 |

**关键观察**:本应用约 100% 的实际内容都需要真实、可交互、可无障碍访问的 DOM
(表单输入、Select/Tooltip 弹出、pdf canvas、markdown、表格、拖拽、中文 IME)。任何渲染方案都必须承载这些 DOM。

---

## 3. liquid-dom 技术概览(基于 `liquid-dom.md`)

- **根节点**:`LiquidCanvas`(自持 WebGPU canvas 与帧循环)或 `LiquidScene`(无头,由外部渲染器 update)。
- **根依赖**:`@liquid-dom/core` 需要 **WebGPU**。
- **DOM 承载**:`Html` 节点把 React children portal 进 layout-owned DOM host,再由渲染器把 HTML **纹理化**后合成进 scene。
- **页面关键约束(来自文档 Integration Notes)**:
  > "DOM-backed `Html` content requires the experimental HTML-in-Canvas API, currently available only behind Chrome's Canvas Draw Element flag: `chrome://flags/#canvas-draw-element`."

---

## 4. 可行性分析(本方案的核心门槛)

### 4.1 运行环境:Tauri 在 Windows 上的 WebView2

doccraft 是 Tauri 2 桌面应用。Windows 上 WebView 是 **WebView2(Edge/Chromium)**,
发布时运行在终端用户机器上,无法要求用户手动打开 Chrome Flag。

### 4.2 事实核对(2026-08)

- `HTML-in-Canvas`(WICG 提案,`canvas-draw-element` flag,`drawElementImage` / `layoutsubtree` / `copyElementImageToTexture` 等)目前**仅存在于 Chrome Canary 的实验 Flag 与 origin trial**,且 WICG 提案明确标注"未标准化,可能变更或移除"。
- 微软 Edge 150(2026-07)平台发布说明中,WebView2 部分**并未提供**该 API。WebGPU 本身在 WebView2 可用(Edge 150 甚至支持 immediates),但这是另一回事。
- 三方引擎(如 Kurogane/CEF)也只是"探索"通过 flag 暴露,属于实验性质,不可作为生产基线。

### 4.3 三种写法对依赖的要求

| 写法 | WebGPU | HTML-in-Canvas(flag)| 在 stock WebView2 可用? |
| --- | --- | --- | --- |
| 纯 GPU `Glass`/`Background` 形状 | 需要 | 不需要 | 可试(仅玻璃形状/布局,无内容) |
| `Html` 节点承载所有业务内容 | 需要 | **必须** | **否(硬阻塞)** |
| 全量替换(布局 + Glass + Html)| 需要 | **必须** | **否(硬阻塞)** |

### 4.4 结论

**对 doccraft 而言,liquid-dom 全量替换当前 UI 在当前发布环境(WebView2)不可行。**
根因单一且明确:业务内容全部需要 `Html` 节点,而 `Html` 节点的 DOM→纹理合成依赖尚在 Canary 的实验 `canvas-draw-element` flag,WebView2 不暴露。

此外还有两点工程风险叠加:

1. **特殊窗口冲突**:项目记忆中的硬约束——截图遮罩窗口必须预创建/隐藏、不得被 IPC 往返阻塞;截图结果窗用 CSS `backdrop-blur`(非 Acrylic)以避免拖拽卡顿。若把这两个高频、高帧、透明窗口迁移到 WebGPU canvas 场景,将直接与"截图命中响应不能被渲染管线卡顿"的既有结论冲突。
2. **可访问性 / 输入法**:中文 IME、表单、pdf 选区等若被纹理化为 GPU 表面,键盘焦点与 IME 合成位置依赖 HTML-in-Canvas 的同步,在未标准化阶段风险极高。

---

## 5. 迁移策略(三种方案)

### 方案 A — 全量替换:不采纳
在 WebView2 无 `canvas-draw-element` 的前提下,`Html` 无法承载业务内容,页面将无法显示任何实际 UI。**作为当前决策直接排除**,仅在 HTML-in-Canvas 于 WebView2 稳定后重评。

### 方案 B — 纯 GPU 玻璃外壳 + DOM 内容(混合):低风险渐进 ⭐ 建议作 P0 验证方向
仅把**装饰性、非内容**的层次用 `LiquidCanvas` 承载(纯 `Glass`/`Background`,不含 `Html`),
业务内容继续留在真实 DOM 之上。但注意:
- 只要用到 `Html`,就被 4.3 阻塞;因此本方案在 stock WebView2 下只能渲染"形状/玻璃/背景",不能把任何组件包进玻璃。
- 收益因此被极大稀释(玻璃底下没有 DOM 内容可纹理化),**性价比存疑**。

> 结论:方案 B 值得先跑一个 5 分钟 PoC 看真实渲染保真度/性能,但预计不足以支撑"重写 UI"的业务价值。

### 方案 C — 坚守现有栈,吸收 liquid-glass 的视觉设计语言(务实落地)⭐ 推荐
保留 DOM + Tailwind 堆栈(不引入 WebGPU 运行时),把 liquid-glass 的**视觉与交互语言**翻译成当前技术栈可实现的形式:
- GPU 玻璃的大圆角 squircle、层叠阴影、hover 抬升、spring 缓动,映射到 flow.stringify 已有 token + CSS transition;
- 截图结果窗已采用 CSS `backdrop-blur`,与 glass 模糊目标一致,继续巩固;
- 把"玻璃面板行式布局"进一步统一(可复用 00002 方案 A 的行语言)。

**优点**:零 WebView2 兼容性风险、不破坏既有性能硬约束、当日可落地、不引入 v0.1.1 实验依赖。
**缺点**:不是真正的 WebGPU 玻璃,追求"液体玻璃跟随内容折射"这类硬核效果时达不到。

### 5.1 方案 C 实施细化(落地清单)

目标:把 liquid-glass 的视觉语言(大圆角 squircle、柔和层叠阴影、hover 抬升、spring 缓动、统一的行式面板)**映射到现有设计 token**,不引入 WebGPU 运行时。全部改动只用 CSS/tailwind 与现有组件。

1. **design tokens 扩展(`src/index.css`)** — 对齐 Glass 的默认语言:
   - `--radius-xl`(现有 0.875rem)→ 提为 squircle 感,面板统一 `rounded-2xl`(已有);
   - 新增 `--glass-tint`、`--glass-border`、`--glass-shadow` 等 token,供暗/亮两套主题各自取值;
   - 玻璃面板统一:`bg-gradient-to-b from-card to-card/[0.92] border border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.06)] backdrop-blur-xl`(与截图结果窗一致的语言)。

2. **建立 `GlassPanel` 基础组件(`src/components/ui/glass-panel.tsx`)**:
   封装上面的毛玻璃面板 + `rounded-2xl` + 可选 `backdrop-blur`,替换散落各处的 `rounded-2xl border bg-card shadow-xs`。
   - 支持 `hover` 抬升(`-translate-y-0.5` + shadow 加深,150ms ease-out)。
   - 复用现有 `cn`。

3. **导航/头部(方案 B 的 `Glass + Html` 映射)**:`app-header.tsx` 的 sticky 头改为毛玻璃胶囊:
   `sticky top-0 z-20 bg-background/[0.72] backdrop-blur-xl border-b border-border/60`。
   活动 tab 沿用主题色 8% 底 + squircle 高亮(参考 00002 方案 A 的行语言)。

4. **行式面板语言复用(衔接 00002 方案 A)**:`Panel + SettingRow` 本已是"圆角面板 + 发丝线行",补充:
   - 设置页底部保存胶囊改为毛玻璃悬浮(`backdrop-blur bg-background/80 border shadow-lg rounded-full`,已实现)→ 统一为 5.2 的玻璃 token。

5. **动效**:新增 `transition` token 统一 `spring` 语感——CSS 上以 `transition-[transform,box-shadow,background-color] duration-150 ease-out` 为主;需要滑动/浮入的效果沿用 `tw-animate-css`。

6. **深色模式**:玻璃面板跟随既有 token(`bg-card`/`border`/`muted`),不新增配色;阴影透明度按 `.dark` 降低,避免纯黑堆叠。

7. **不动项**:`src/lib/*`、Tauri 后端、i18n、`next-themes`;截图遮罩/结果窗维持现有性能硬约束路径。

**验收**:主窗口四个视图 + 头部 + 设置页按上述 token 呈现统一玻璃质感;截图/性能行为与现状一致;无 WebGPU/新依赖。

---

## 6. 若未来门槛解除(HTML-in-Canvas 稳定/WebView2 可用)的迁移路径

以下内容作为前瞻记录,不构成当前实施。

### 6.1 目录与依赖
```
pnpm add @liquid-dom/react @liquid-dom/core
```

### 6.2 应用外壳骨架(示意)
```tsx
<LiquidCanvas style={{ width: '100vw', height: '100vh' }}>
  <GlassContainer blur={12} spacing={28}>
    <VStack spacing={16}>
      <Html sizing="fill">
        <AppHeader />
      </Html>
      {/* BatchView / ImageToMdView / … 以 Html 承载 */}
    </VStack>
  </GlassContainer>
</LiquidCanvas>
```

### 6.3 组件映射表(迁移时对照)

| 现有组件 | 目标 liquid-dom 结构 | 备注 |
| --- | --- | --- |
| 应用外壳/背景 | `GlassContainer` + `Background` | 光学参数集中配置 |
| 头部导航 | `Glass`(cornerRadius/squircle)内嵌 `Html` | Radix Tabs 逻辑保留在 `Html` 内 |
| 面板/卡片 | `Glass` + `Frame(width/height)` | `Html` 承载内容与表单控件 |
| 分区/留白 | `HStack`/`VStack`/`Spacer` | 替换 flexbox gap |
| 悬浮保存胶囊(设置页) | `Html` + `transition`(opacity/slide) | spring 动画 |
| 截图结果窗 | **不建议迁移** | 维持 CSS backdrop-blur,避免拖拽/命中延迟 |
| 截图遮罩 | **不建议迁移** | 维持现有性能硬约束路径 |

### 6.4 需要保留(迁移中不动)
- `src/lib/ipc.ts`、`src/lib/types.ts`、Tauri 后端逻辑;
- `next-themes`、`index.css` 的 tokens(Glass 的 tint/shadow 颜色仍来自 design tokens);
- i18n(`useI18n`)、全局任务状态(`lib/global-task.ts`)、并发控制(`lib/concurrency.ts`)。

### 6.5 动画迁移
用 `transition` 描述声明式动画(以 `Html`/`Frame` 的 layout 属性),替换 Radix 的 CSS enter/exit 动画:
```tsx
<Frame
  width={expanded ? 260 : 140}
  transition={{ width: spring({ stiffness: 360, damping: 30 }) }}
/>
```

### 6.6 风险与缓解(迁移路径)
- **HTML-in-Canvas 未标准化,API 可能变更**:在 Chrome Canary 里做 PoC;把"玻璃/布局"与"业务 DOM"用组件边界解耦,便于升级。
- **无障碍 / 中文 IME**:每迁移一个视图做键盘与 IME 回归。
- **性能**:`LiquidCanvas` 用 `frameloop="demand"` + `onInvalidate*` 做按需渲染;隔离高频窗口。

---

## 7. 决策项(需确认)

1. **是否接受"全量替换当前不可行"的结论**,放弃立即引入 WebGPU 运行时?
2. 若选择方案 C:是否先在 `docs/design` 出一份"liquid-glass 视觉语言落地到现有栈"的细化稿?
3. 是否值得先在本机 Chrome Canary(打开 `canvas-draw-element`)跑一个 5 分钟 PoC 以保留完整方案 B 的可能性?

---

## 8. 建议

短期采纳 **方案 C**:守住 DOM/Tailwind 栈,吸收 liquid-glass 视觉语言,零兼容风险、不影响既有性能硬约束。
以本文件 + 一个 Chrome Canary PoC 作为"未来真正迁移"的可行性档案;
待 WICG HTML-in-Canvas 进入 Chromium 稳定并由 WebView2 跟进后,再按第 6 节路径正式迁移。