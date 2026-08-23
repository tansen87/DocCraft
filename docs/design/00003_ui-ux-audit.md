# UI/UX 优化审计与建议

状态:待评审(按优先级逐项落地)
关联:`src/App.tsx`、`src/components/layout/app-header.tsx`、各视图与工作区组件

## 范围与方法

对 App 外壳(顶部 Tab 导航)、PDF→MD / 图片→MD / MD→Excel 三个工作区、
设置页与截图遮罩进行走查,按「收益 / 成本」排序。
已确认的良好实践不在列:三视图常驻挂载保状态(App.tsx)、Markdown 预览懒分页、
Excel 行窗口化、设置页分组面板布局。

## 高收益(建议优先)

### 1. 后台任务状态不可见 ✅

转换运行中切换到设置或其他 tab 后没有任何进行中的提示,容易误以为已完成而直接关软件。

- 实现:新增轻量外部 store `src/lib/global-task.ts`
  (`setViewTask(tab, text)` / `useGlobalTasks()`);AppHeader 为每个
  运行中的任务渲染一个胶囊(spinner + tab 名 + 进度数字),点击跳回对应
  工作区。三个视图分别上报:PDF 批量(完成/总数)、图片识别
  (activity 计数)、MD 分析(分析中数量)。

### 2. 批量转换不可取消 ✅

PDF 批量队列一旦开始只能等它结束;图片转 MD 已有停止按钮,体验不一致。
后端 `hybrid_session_abort` 已存在但前端未暴露。

- 实现:
  - `convertWithOcr` 接受 `isCancelled` 轮询信号,在会话启动 / 每页 OCR 前
    / 收尾前检查,取消时抛 `CancelledError` 并 abort 后端 session;
  - 「停止」按钮升级为整体取消:进行中的转换被中断并回到队列,
    按「开始」从断点处继续;
  - 列表行内:转换中的行显示「取消」按钮(单文件取消,回到排队状态,
    不会被池子自动重跑;需显式重试);非转换行保留移除按钮。

### 3. 导出成功后缺「打开位置」 ✅

导出成功的 toast 只显示路径文本,用户需要自己去资源管理器找文件。

- 方案:toast 加「打开文件夹」action(opener 能力已有依赖),桌面工具最自然的闭环。

## 中等收益

### 4. tablesOnly 双入口不同步 ✅

`md-to-xlsx.tsx` 内有本地 `tablesOnly` state,设置页又有 `excelTablesOnly`,
两处各自为政,一处修改另一处无感知。

- 实现:设置保存成功后广播 `doccraft:settings-saved` window 事件;
  MD→Excel 视图监听该事件并重读设置(同时移除了原来靠 ResizeObserver
  触发的脆弱刷新 hack)。视图内不再有独立开关,统一由 settings 驱动。

## 低成本打磨

| # | 项目 | 说明 |
|---|------|------|
| 7 | Tab 记忆 + 快捷键 | ✅ 当前 tab 持久化到 localStorage;Ctrl+1~4 快速切换 |
| 8 | Toast 遮挡 | ✅ 已移至 bottom-right,不再遮挡 sticky header / 工具栏 |

## 不建议改动

- 三视图常驻挂载以保留状态(有意为之,App.tsx 有注释)
- Markdown 预览 / Excel 预览的懒加载与窗口化策略
- 设置页 Soft Rows 分组面板布局(刚落地)
