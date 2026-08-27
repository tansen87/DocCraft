# Glass 面板透明度同步系统 (Glass Opacity Sync)

状态: 已落地
关联: [00006_liquid-dom-ui-migration.md](./00006_liquid-dom-ui-migration.md)、[00007_ui-modernization.md](./00007_ui-modernization.md)
范围: `src/App.tsx`、`src/lib/glass-opacity.ts`、`src/components/ui/glass-panel.tsx`、`src/index.css`、所有使用 `GlassPanel` 的组件

---

## 1. 架构概览

```
┌─ App.tsx ─────────────────────────────────────┐
│  glassOpacity state (0-100)                    │
│  ┌──────────────────────────────────────────┐  │
│  │ <GlassOpacityContext value={glassOpacity}>│  │
│  │   ├─ root div  → backgroundColor         │  │
│  │   ├─ AppHeader → glass-panel + opacity   │  │
│  │   ├─ GlassPanel (×N) → --glass-bg-opacity│  │
│  │   └─ ...                                  │  │
│  └──────────────────────────────────────────┘  │
└───────────────────────────────────────────────┘
```

**核心思路**: 主窗口背景和所有 glass 面板共享同一个 opacity 值，但实现方式不同：
- 主窗口背景: `color-mix(in srgb, var(--background) N%, transparent)` 直接设在 root div 上
- Glass 面板: 通过 `--glass-bg-opacity` CSS 变量控制 `::before` 伪元素的背景渐变

**为什么不用 `opacity` CSS 属性**: `opacity` 会同时影响文字，拖到 0 时文字消失。用 `::before` 伪元素做背景层，文字在上层不受影响。

---

## 2. 文件职责

| 文件 | 职责 |
|------|------|
| `src/lib/glass-opacity.ts` | 导出 `GlassOpacityContext` + `useGlassOpacity()` hook |
| `src/App.tsx` | 提供 `GlassOpacityContext`，管理 `glassOpacity` state，监听 `doccraft:opacity-preview` 事件 |
| `src/components/ui/glass-panel.tsx` | 读取 context，设置 `--glass-bg-opacity` inline style |
| `src/index.css` | `.glass-panel::before` 用 `color-mix()` + `--glass-bg-opacity` 渲染背景 |
| `src/components/layout/app-header.tsx` | 手动设置 `--glass-bg-opacity`（未使用 GlassPanel 组件） |
| `src/views/settings.tsx` | `Panel` 包装 `GlassPanel`；滑块拖动时 dispatch `doccraft:opacity-preview` 事件 |

---

## 3. CSS 变量链路

```
:root {
  --glass-top: oklch(1 0 0);        /* 亮色 base 色，不含 alpha */
  --glass-bottom: oklch(0.985 0 0);
}
.dark {
  --glass-top: oklch(0.25 0 0);     /* 暗色 base 色 */
  --glass-bottom: oklch(0.2 0 0);
}

.glass-panel::before {
  background-image: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--background) var(--glass-bg-opacity), transparent),
    color-mix(in srgb, var(--background) calc(var(--glass-bg-opacity) * 0.92), transparent)
  );
}
```

**关键点**:
- `--glass-bg-opacity` 范围 0~1（由 `glassOpacity / 100` 计算）
- 使用 `--background` 而非 `--glass-top` 做混合色，确保卡片和窗口背景同色同透明度
- 渐变从 100% → 92% 保持微妙的玻璃质感

---

## 4. 新增 GlassPanel 元素的规范

**必须** 使用 `<GlassPanel>` 组件，不要用原生 `<div className="glass-panel">`：

```tsx
import { GlassPanel } from "@/components/ui/glass-panel";

<GlassPanel className="rounded-xl px-3 py-2">
  {/* content */}
</GlassPanel>
```

**禁止**:
```tsx
// ❌ 不要这样做 — 缺少 --glass-bg-opacity，背景渐变不生效
<div className="rounded-xl glass-panel px-3 py-2">
```

如果需要 blur 效果，传 `blur` prop（默认 true）：
```tsx
<GlassPanel blur className="rounded-xl px-3 py-2">
```

如果需要 hover 动效，传 `hover` prop：
```tsx
<GlassPanel hover className="rounded-xl px-3 py-2">
```

---

## 5. 特殊场景

### 5.1 AppHeader

AppHeader 没有使用 `<GlassPanel>` 组件，而是手动设置 CSS 变量：

```tsx
<header
  className="sticky top-0 z-20 glass-panel glass-blur flex h-12 ..."
  style={{ "--glass-bg-opacity": opacity / 100 } as React.CSSProperties}
>
```

需要同时 import `useGlassOpacity`。

### 5.2 snip-result-window

运行在独立的 Tauri webview 中，无法访问 `GlassOpacityContext`。使用自己的 `glassOpacity` state（从 `getAppSettings().snipResultOpacity` 加载），通过 `snip:settings-changed` 事件接收更新。

### 5.3 实时预览

拖动滑块时通过 CustomEvent 实时预览，无需保存：

```tsx
// settings.tsx — 拖动时 dispatch
window.dispatchEvent(
  new CustomEvent("doccraft:opacity-preview", { detail: { opacity: value } })
);

// App.tsx — 监听
window.addEventListener("doccraft:opacity-preview", (e) => {
  setGlassOpacity((e as CustomEvent).detail.opacity);
});
```

---

## 6. 故障排查

| 现象 | 原因 | 修复 |
|------|------|------|
| 卡片背景不随滑块变化 | 用了原生 `<div className="glass-panel">` | 改用 `<GlassPanel>` 组件 |
| 拖到 0 时文字消失 | 用了 `opacity` CSS 属性 | 改用 `::before` 伪元素方案 |
| 卡片比窗口背景更亮 | 用了 `--glass-top`（纯白）而非 `--background` | `::before` 中用 `var(--background)` 做混合色 |
| 暗色模式下卡片颜色不对 | `--glass-top`/`--glass-bottom` 没有分亮暗色定义 | 确保 `.dark` 中覆盖了这两个 token |
| 新组件编译报错找不到 GlassPanel | 忘记 import | 添加 `import { GlassPanel } from "@/components/ui/glass-panel"` |
