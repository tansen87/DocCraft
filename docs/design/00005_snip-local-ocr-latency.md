# 截图本地 OCR 识别延迟优化(引擎常驻后的残余耗时)

状态标记:✅ 已完成 · ⬜ 未实施

> **实施状态(2026-08)**:S-1…S-7 已全部落地,详见文末各方案标记。
> 唯一偏差:`use_cache`(MNN 缓存)未启用 —— ocr-rs 2.4 的
> `OcrEngineConfig::to_inference_config()` 硬编码 `use_cache: false`,
> 公开 API 无法覆盖,待上游支持后再开。

## 背景

[00001_snip-performance.md](./00001_snip-performance.md) 完成后,遮罩弹出(阶段 A)
与引擎加载(阶段 B,B-1 引擎缓存)均已优化。但实际使用中仍存在如下场景:

- 「缓存本地 OCR 引擎」已开启(引擎常驻,无冷加载);
- 单张截图,尺寸约 **1000×300**(小图);
- 本地 PaddleOCR 模式;
- 框选确认后到结果弹出仍有可感知的等待。

本文分析该场景下剩余的耗时热点,并给出分阶段优化方案。

## 链路回顾(框选确认 → 结果)

优化前的链路(各热点标注在右侧):

```
snip:selected
  → finish(false):隐藏遮罩窗口(await,IPC 往返 ×N)        [前端,H-6]
  → screenshot_ocr 命令
      → 裁剪 + PNG(Fast)编码 + 写盘                        [Rust,H-3]
      → 缩略图编码 + base64                                 [Rust,H-3]
      → get_app_settings()(读盘 JSON ×3 次)                [Rust,H-4]
      → acquire_local_ocr_engine()(async 线程上直接调用)    [Rust,H-5]
      → 从磁盘读回 PNG → 解码                               [Rust,H-3]
      → engine.lock() → det 推理 → N 行 × rec 推理           [Rust,MNN,H-1/H-2]
  → 自动复制剪贴板 + 弹出结果窗口                            [前端]
```

优化后的链路(S-1…S-6 落地):

```
snip:selected
  → void finish(false)(与 OCR 并发)+ 预取设置               [前端,S-5]
  → screenshot_ocr 命令
      → [blocking] 裁剪 + 缩略图 base64                      [Rust,S-3]
      → [blocking] acquire_snip_ocr_engine()(专用引擎,S-2;
        冷加载不再阻塞命令执行器,S-4)
      → [blocking] 内存 RGBA 直送 recognize_image()          [Rust,S-3]
        (线程自适应 + f16 低精度,S-1;设置走进程内缓存,S-4)
      → 识别后才编码 PNG 落盘(retry/export 用)              [Rust,S-3]
      → 返回 cropMs / inferMs / saveMs 分段计时              [S-6]
  → 自动复制剪贴板(用预取设置)+ 弹出结果窗口                [前端,S-5]
```

## 热点分析

### H-1 MNN 推理参数全部使用默认值 ✅(已由 S-1 / S-7 解决)

`LocalOcrEngine::new`(`src-tauri/src/core/ocr.rs`)调用
`OcrEngine::new(det, rec, keys, None)` —— 第 4 参 `config` 传 `None`,
即 ocr-rs 2.4 的 `OcrEngineConfig::default()`:

| 参数 | 默认值 | 问题 | 处理 |
|------|--------|------|------|
| `InferenceConfig.thread_count` | 固定 `4` | 不是按物理核数自适应;8 核以上机器浪费算力,2 核机器可能过订阅 | ✅ S-1:`available_parallelism()` 自适应 |
| `InferenceConfig.precision_mode` | `PrecisionMode::Normal` | ocr-rs 提供 `Low`(f16)模式,CPU 上通常再快 ~30–50%,OCR 精度损失可忽略 | ✅ S-1:默认 `Low`,`ocrLowPrecision` 可关 |
| `InferenceConfig.use_cache` | `false` | MNN 几何/权重缓存未启用 | ⬜ ocr-rs 2.4 公开 API 无法设置,放弃 |
| 模型档位 | `medium` rec(~36.6MB) | small 档更快 | ✅ S-7:`ocrModelSize` 设置项 |

对一张 1000×300、含若干文本行的截图,det 一次 + 每行一次 rec,
在"4 线程 + Normal 精度"下典型耗时 **300ms–1s+**;调优后有数倍的下降空间。

### H-2 引擎互斥锁串行化 ✅(已由 S-2 解决)

常驻引擎为 `Arc<Mutex<LocalOcrEngine>>`,截图识别在 `engine.lock()` 内完成
(`snip.rs` `screenshot_ocr` 本地分支)。若 Image→Markdown 批量队列、hybrid PDF
页面或 draw-table 正在进行本地识别,截图推理必须排队等锁 —— 表现为
"小截图也要等很久"。截图是交互路径,不应排在批量任务之后。
现已由截图专用 `SnipEngineCache` 实例解决,批量任务继续走共享实例。

### H-3 磁盘往返与重复编解码 ✅(已由 S-3 解决)

`screenshot_ocr` 原流程:

1. 裁剪出的 RGBA → PNG 编码 → 写入 `screenshots/shot-*.png`;
2. 再从磁盘把这个 PNG **读回来** → 解码成 `DynamicImage` 才喂给引擎;
3. 另外还做了缩略图的第二次 PNG 编码 + base64。

对 1000×300 约 30–80ms 的纯开销。现已改为内存直送推理
(`recognize_image`),落盘移到识别之后仅服务 retry/export。

### H-4 设置文件反复读盘 ✅(已由 S-4 解决)

单次 `screenshot_ocr` 调用 `settings::get_app_settings()` 三次
(顶层 `ocr_mode`、本地分支的 `text_separator`、`acquire_local_ocr_engine`
内部的 `cache_ocr_engine`),每次都读盘并解析 JSON。量级小(~几 ms),
但属于白丢的时间,且阻塞 async 运行时线程。
现已由进程内 `OnceLock<RwLock>` 缓存(写穿同步)解决。

### H-5 `acquire_local_ocr_engine` 在 async 线程上同步调用 ✅(已由 S-4 解决)

原实现中该调用发生在 `spawn_blocking` 之外。缓存命中时只是拿个
`Arc` 很快;但一旦缓存被关闭又重新打开、或进程内引擎刚被释放,
~0.5–2s 的模型加载会**卡住整个 Tauri 命令执行器**,其他 IPC 全部停摆。
现已整体挪进 `spawn_blocking`。

### H-6 前端串行的收尾流程 ✅(已由 S-5 解决)

`image-to-md.tsx` `onSelected`:原来先 `await finish(false)`(隐藏所有遮罩窗口,
每显示器一次 IPC 往返)**然后才**发起 `screenshot_ocr`;识别完成后还要先查
设置再复制剪贴板 / 弹结果窗。现已改为遮罩隐藏与 OCR 请求并发、
设置在框选期间预取。

### H-7 rec 模型档位 ✅(经 S-7 落地)

当前使用 `PP-OCRv6_medium_rec`(~36.6MB)。ocr-rs 对每条检测行都要跑一次
rec,medium 档在小字/多行场景下明显慢于 small 档。已作为设置项提供
"速度优先(small)/ 精度优先(medium)"选择。

## 方案

### S-1 定制 `OcrEngineConfig`(对应 H-1)✅

- `LocalOcrEngine::new_with_config()` 接收 `OcrEngineConfig`;
  `create_local_ocr_engine()` 按设置构建:
  - `thread_count`:`std::thread::available_parallelism()`
    (物理/逻辑核数自适应,clamp 1–16);
  - `precision_mode`:默认 `Low`(新增设置「低精度加速」`ocrLowPrecision`,
    默认开;关闭则回退 `Normal`);
- 注意:引擎参数在创建时固化,**修改相关设置后会同时清空
  `OcrEngineCache` 与 `SnipEngineCache`**,下次使用按新参数重建
  (`apply_app_settings` 副作用管线,lib.rs);
- 预期收益:推理段 30–60% 提速;多核机器更多。

### S-2 截图专用引擎实例,绕开共享锁(对应 H-2)✅

- 新增 managed state `SnipEngineCache`(`core/ocr.rs`)与
  `acquire_snip_ocr_engine()`;截图路径改用专用实例,
  批量任务(hybrid 页面 / image-to-md / draw-table)继续共享
  `OcrEngineCache`,二者互不排队;
- 内存代价:开启「缓存本地 OCR 引擎」时多驻留 ~66 MB(双实例);
- 共享获取逻辑抽取为私有 `acquire_from_cell(app, cell)` 复用。

### S-3 消除磁盘往返(对应 H-3)✅

- `screenshot_ocr`(`core/snip.rs`)重构为三段 blocking 任务:
  - 阶段 1:裁剪出 `RgbaImage` + 编码 IPC 缩略图 base64;
  - 本地模式阶段 2:`DynamicImage::ImageRgba8(cropped.clone())` 直接送
    新增的 `LocalOcrEngine::recognize_image()`,识别完成后才编码 PNG 落盘
    (retry/export 用),不再写盘→读盘→解码;
  - AI 模式:全分辨率 PNG 编码 + 落盘一次完成,base64 复用同一份字节。
- `recognize_bytes` 保留(= 解码 + 委托 `recognize_image`),其余调用方不变。

### S-4 设置进程内缓存 + 移出 async 线程(对应 H-4/H-5)✅

- `settings.rs` 增加 `OnceLock<RwLock<Option<AppSettings>>>` 进程内缓存:
  `get_app_settings` 读缓存(miss 才读盘并回填),`set_app_settings`
  写穿(写盘 + 更新缓存);配置导入走 `set_app_settings`,天然同步;
- 截图本地分支的 `acquire_snip_ocr_engine` 整体挪进 `spawn_blocking`,
  冷加载不再卡命令执行器。

### S-5 前端流水线化(对应 H-6)✅

- `image-to-md.tsx` `onSelected`:`void finish(false)` 与
  `recognizeShot(...)` 并发,遮罩隐藏不再串行阻塞 OCR 发起;
- 遮罩弹出期间预取 `getAppSettings()`,结果返回后直接用于自动复制/弹窗判断;
  `recognizeShot` 接受可选的预取参数,兜底仍会现取;
- 结果窗口保持现有 hide/reuse 复用策略不变。

### S-6 分段计时埋点(验证手段)✅

- `OcrImageResult` 新增可选分段字段(screenshot 管线专属,序列化时缺省省略):
  `cropMs`(裁剪 + 缩略图)、`inferMs`(本地 det+rec 或远程 AI 往返)、
  `saveMs`(全分辨率 PNG 编码 + 落盘);`durationMs` 保持总耗时不变;
- det/rec 无法在 ocr-rs 内部拆分,以 `inferMs` 合并计量。

### S-7 模型档位选择(H-7 落地)✅

- 新增设置 `ocrModelSize`(`small` / `medium`,默认 `medium`):
  - `small`:`PP-OCRv6_small_det.mnn` + `PP-OCRv6_small_rec.mnn`
    + `ppocr_keys_v6_small.txt`,速度约快 2–3 倍,精度略低;
  - `medium`:原默认档,精度优先;
- 设置页 OCR 区新增「识别模型」下拉框(中英文案齐全);
- 切换档位与精度开关一样,会清空两个引擎缓存并按新档位重建;
- 原「GPU 后端」方案已按产品决策**移除**(设置项、Cargo feature、
  backend 探测逻辑一并删除);如未来需要可参考 git 历史恢复。

## 实施顺序与预期收益

| 阶段 | 内容 | 预期效果(1000×300,热引擎) |
|------|------|------------------------------|
| 1 | S-1 + S-3 | 推理段 300–1000ms → ~150–400ms;省 30–80ms IO |
| 2 | S-4 + S-5 | 再省 50–150ms 可感知延迟;消除偶发卡顿 |
| 3 | S-2 | 截图延迟不再受批量任务影响 |
| 4 | S-6 / S-7 | 分段计时可持续度量;small 档模型进一步提速 |

目标:热引擎下框选确认 → 结果可见 **≤ 500ms**。

## 验证方式

```bash
pnpm exec tsc --noEmit                    # 前端类型检查
cargo test --manifest-path src-tauri/Cargo.toml   # snip / settings 单测
cargo check --manifest-path src-tauri/Cargo.toml
```

人工验收:

1. 连续截图同一 1000×300 区域,记录 `duration_ms` 与分段计时,对比优化前后;
2. 开启 Image→Markdown 批量识别(本地 OCR)的同时截图,确认截图不被批量任务阻塞(S-2);
3. 切换「低精度加速」开关,确认识别结果无明显退化且引擎按预期重建(S-1);
4. 断网环境回归 AI 模式不受影响;`disabled` 模式行为不变。
