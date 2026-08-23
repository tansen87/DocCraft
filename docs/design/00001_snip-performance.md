# 截图识别性能优化方案(Snip Performance)

状态标记:✅ 已完成 · ⬜ 未实施

## 背景

按下截图快捷键后,约需 1–2s 才能出现框选遮罩;框选确认后到出结果也有可感知的等待。
本文记录全链路耗时热点与分阶段优化方案。

## 链路与耗时热点分析

### 阶段 A:按键 → 框选遮罩出现(用户感知的主要延迟)

| # | 步骤 | 位置 | 估计耗时 |
|---|------|------|----------|
| A1 | 全屏捕获 `xcap::Monitor::capture_image()` | `src-tauri/src/core/snip.rs` `capture_under_cursor` | ~50–150ms |
| A2 | **全屏 PNG 编码**(2560×1440 ≈ 14.7MB RGBA,Fast 压缩)+ base64 | 同上 | ~100–300ms |
| A3 | 巨型 base64 字符串走 IPC 事件 → 主窗口 `localStorage.setItem` | `src/views/image-to-md.tsx` `showOverlay` | ~50–150ms |
| A4 | **每次 `new WebviewWindow`:WebView2 窗口冷启动 + React 应用启动** | `image-to-md.tsx` `showOverlay` | **~300–800ms(dev 更慢)** |

### 阶段 B:框选确认 → OCR 结果

| # | 步骤 | 位置 | 估计耗时 |
|---|------|------|----------|
| B1 | crop + PNG 编码(image crate 默认压缩级,慢于 Fast)| `snip.rs` `screenshot_ocr` | ~50–200ms |
| B2 | **每次调用 `create_local_ocr_engine()`:从磁盘重新加载 MNN det/rec 模型并初始化推理引擎** | `src-tauri/src/core/ocr.rs`;模型文件合计 ~66MB(det 29.6 + rec 36.6)| **~500–2000ms ← 最大热点** |
| B3 | 实际推理(引擎热身后,小图)| `snip.rs` | ~100–300ms |

## 阶段 A:遮罩弹出提速 ✅

### A-1 快照底图改 JPEG 编码 ✅

- **问题**:`begin_screenshot` 对整屏 RGBA 做 PNG(Fast)编码,100–300ms,且 base64 后
  数 MB 的字符串要经过 IPC 事件、`localStorage` 写入两层搬运。
- **方案**:预览底图改用 JPEG(quality 85)编码——编码速度快数倍、体积小数倍。
  裁剪识别仍使用 `SnipStore` 中缓存的**原始 RGBA 帧**,精度不受底图压缩影响
  (屏幕快照不透明,RGBA→RGB 无损)。
- **改动点**:`snip.rs` `capture_under_cursor`(新增 `encode_preview_jpeg`)。

### A-2 裁剪编码换 Fast 压缩 ✅

- **问题**:`screenshot_ocr` 里裁剪区域用 `encode_png`(image crate 默认压缩级)。
- **方案**:统一走已有的 `encode_fast_png`(PNG Compression::Fast),删除旧函数。

### A-3 遮罩窗口复用/预热 ✅

- **问题**:每次截图都 `new WebviewWindow(...)` → WebView2 新建窗口 + 整个前端应用冷启动,
  是阶段 A 最大的一块;会话结束即 `close()` 销毁,下次又要重来。
- **方案**:**懒预热 + 复用**
  - 首次截图仍按需创建(冷启动只发生一次);会话结束时**隐藏(`hide()`)而非销毁**;
  - 再次截图时若同显示器(`snip-<monitorId>`)窗口仍存活则直接复用:
    更新 `localStorage` 快照 → `emitTo(label, "snip:meta", meta)` 通知遮罩刷新内容 →
    校正位置尺寸 → `show()` + 置顶 + 聚焦;
  - 遮罩组件监听 `snip:meta`,重读快照并复位拖拽状态;确认/取消后自行 `hide()`。
  - 多显示器各保留一个窗口;分辨率变化时复用前会重新 setPosition/setSize。
  - 权衡:每个隐藏窗口常驻约几十 MB WebView 内存;如需回收可在后续版本加空闲超时关闭。

**阶段 A 预期收益**:第二次起的截图,按键 → 可框选 从 ~1–2s 降至 ~150–350ms
(捕获 + JPEG 编码 + show 已存窗口)。

## 阶段 B:识别提速 ✅

### B-1 本地 OCR 引擎缓存(可选设置开关)✅

- **原状**:`create_local_ocr_engine()` 每次调用都重新加载并初始化 MNN 引擎,
  影响所有本地 OCR 路径(screenshot / image-to-md / hybrid 页面 / draw-table)。
- **实现**:
  - managed state `OcrEngineCache(Mutex<Option<Arc<Mutex<LocalOcrEngine>>>>)`
    (`core/ocr.rs`),进程内首次使用后常驻;新增 `acquire_local_ocr_engine()`
    统一获取入口——设置开启时返回常驻引擎,关闭时每次新建、用后即弃;
  - 设置页 OCR 区新增开关「缓存本地 OCR 引擎」(默认开);
    关闭并保存后立即释放内存(`set_app_settings` 中调 `OcrEngineCache::clear`);
  - 内存代价:常驻约 100–200 MB(权重 ~66MB + MNN 会话工作区/中间张量),
    推理瞬间随图片尺寸有峰值;
  - 不缓存的代价:每次本地识别多等 ~0.5–2s(仅影响结果返回时间,不影响遮罩弹出);
  - 注意:共享引擎的内部锁会把并发的本地识别串行化(CPU 密集型推理,
    单引擎串行通常优于多个引擎争抢核心);`ocr_rs::OcrEngine` 未声明 Send/Sync,
    故以 `Mutex` 包裹保证跨线程安全。

### 其他候选

- B-2 AI 模式:共享 `reqwest::Client`(连接池复用,减少 TLS 握手)。✅
  `core/ocr.rs` 新增 `shared_http_client()`(OnceLock 进程级单例),
  hybrid 会话与 `resolve_remote_provider` 共用同一连接池。
- B-3 结果缩略图(pngBase64)降采样。✅
  `snip.rs screenshot_ocr` 的 IPC 回传缩略图长边压到 ≤480px
  (`thumbnail_rgba`,Triangle 滤镜);落盘 PNG 与 OCR 输入仍为全分辨率,
  重试/导出不受影响。

## 验证方式

```bash
pnpm exec tsc --noEmit                    # 前端类型检查
cargo test --manifest-path src-tauri/Cargo.toml   # snip 单测(clamp_region 等)
cargo check --manifest-path src-tauri/Cargo.toml
```

人工验收:连续触发两次截图快捷键,第二次遮罩应几乎立即出现;
框选后结果返回时间明显缩短(阶段 B 完成后)。
