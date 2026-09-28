# 模型在线下载 + 本地导入方案

状态标记：◐ 已实施（2026-09-28）

> **结论**：
> 1. **模型来源用 ModelScope，不新建 GitHub 仓库**（实测：匿名直连、支持 Range、
>    API 自带 SHA-256）。GitHub Release 附件只作为将来的备源选项，本期不用。
> 2. **清单内置在应用里**（文件名 / 体积 / SHA-256 / 目标路径），模型与 URL 一一锁定；
>    换仓库或加档位只改一处常量，不动下载逻辑。
> 3. 下载流程：流式写入 `<models>/.download/<name>.part` → **校验体积 + SHA-256** →
>    原子 rename 到位。校验不过就丢弃，**绝不会把坏文件放进模型目录**。
> 4. 同时支持**本地导入**：把模型文件（或整个文件夹）拖进设置页，或手动选择；
>    同样按名称识别 + 体积/哈希校验，且**只复制不移动**用户的文件。
> 5. 设置页新增「模型」分组：每个档位显示体积、已装/未装、下载按钮与进度条，
>    底部是拖放区，并显示文件的最终落点（`<安装目录>\models`）。

## 一、背景

`00020` 把模型移出了安装包（安装包从 21MB 降到 6MB），`00021` 之后应用可以自更新，
但**安装完没有任何模型**：本地 OCR 会提示
`OCR model directory not found. Please place models at: <安装目录>\models`。
所以需要一个"按需获取模型"的入口，这也是 00020 §3.4.1 预留的后续工作。

需要覆盖的文件（`core::ocr` / `core::layout` 在运行时按这些名字查找）：

| 档位 | 文件 | 体积 |
|------|------|------|
| OCR tiny | `PP-OCRv6_tiny_{det,rec}.mnn` + `ppocr_keys_v6_tiny.txt` | ≈3.1MB |
| OCR small | `PP-OCRv6_small_{det,rec}.mnn` + `ppocr_keys_v6_small.txt` | ≈15.7MB |
| OCR medium | `PP-OCRv6_medium_{det,rec}.mnn` + `ppocr_keys_v6_medium.txt` | ≈69.6MB |
| 版面 PP-DocLayoutV3 | `layout/PP-DocLayoutV3/{PP-DocLayoutV3.mnn,layout-meta.json}` | ≈124.5MB |

## 二、来源选型：ModelScope vs GitHub Release 附件

| 维度 | ModelScope（选用） | GitHub Release 附件 |
|------|--------------------|---------------------|
| 现状 | 版面模型**已上传**（`tansen87/PP-DocLayoutV3_mnn`） | 需要新建仓库或往 release 传 130MB 附件 |
| 国内访问 | 快（本项目的目标用户群） | 常被限速/不可达 |
| 匿名访问 | ✅ 实测 200，无登录 | ✅ 公开仓库不需要登录 |
| 断点/分块 | ✅ 实测 `206 Partial Content`（`Range` 可用） | ✅ 支持 |
| 完整性元数据 | ✅ API 返回每个文件的 `Sha256` / `Size` / `Revision` | 需自己算、自己发布校验值 |
| 与发版解耦 | ✅ 模型可随时替换（清单锁哈希） | ❌ 模型跟着 release 走 |

实测记录（2026-09-28，本机 `curl`）：

```bash
# 普通文件（走同一个 repo 端点）
curl -sL "https://www.modelscope.cn/api/v1/models/tansen87/PP-DocLayoutV3_mnn/repo?Revision=master&FilePath=layout-meta.json"
#   → 200, application/json, 1444 bytes, sha256 = da1a4deb…（与 API 声明一致）

# LFS 大文件 + 范围请求
curl -sL -r 0-1023 "https://www.modelscope.cn/api/v1/models/tansen87/PP-DocLayoutV3_mnn/repo?Revision=master&FilePath=PP-DocLayoutV3.mnn"
#   → 206, application/octet-stream, 返回真实二进制头

# 目录列表（拿到每个文件的 Sha256 / Size / Revision）
curl -s "https://www.modelscope.cn/api/v1/models/tansen87/PP-DocLayoutV3_mnn/repo/files?Revision=master"
```

结论：用统一的 `repo?Revision=&FilePath=` 端点即可（普通文件与 LFS 同一形式），
不需要为 LFS 写第二套逻辑。

### 2.1 坑：下载请求**必须带 `User-Agent`**（2026-09-28 实测）

`repo` 端点会 302 到 `cdn-lfs-cn-1.modelscope.cn/...&auth_key=<deadline>-<sig>`，
**该 CDN 对没有 `User-Agent` 的请求直接返回 `403 Forbidden`**：

```bash
U="https://www.modelscope.cn/api/v1/models/tansen87/PP-OCRv6_mnn/repo?Revision=master&FilePath=PP-OCRv6_tiny_det.mnn"
curl -s -o /dev/null -L -r 0-99 -H "User-Agent:" -w "%{http_code}\n" "$U"   # → 403
curl -s -o /dev/null -L -r 0-99 -A "DocCraft/0.2.0" -w "%{http_code}\n" "$U" # → 206
```

症状是"URL 明明是对的却 403"（浏览器里能下、curl 默认能下，只有应用不行）。
`reqwest` **不发送默认 UA**，所以模型下载客户端必须显式设置
（`model_files::http_client()`，与 updater 对 GitHub 的处理一致）。
为此 `403` 的错误文案里直接写明"the download client must send a User-Agent"，
避免下次又要从头排查。

## 三、设计

### 3.1 内置清单（数据即配置）

`core/model_files.rs` 里一张表：4 个组、11 个文件，每个文件带
`name`（落盘名，也是本地导入时的识别名）、`target`（相对 `<安装目录>\models`）、
`remote`（ModelScope 仓库内的路径）、`size`、`sha256`。

- **为什么要内置而不是远程拉清单**：免掉"清单自己要不要签名"的问题。清单随应用版本走，
  而 URL 指向的 revision + SHA-256 一起锁定内容，所以清单本身不需要额外保护。
- **换源/加档位只改一处**：仓库名是常量（`MS_OCR_REPO` / `MS_LAYOUT_REPO`），
  加档位就是往表里加一组。
- 哈希来源：ModelScope API 声明的 `Sha256`，并已与本机 `src-tauri/resources/models`
  的文件逐个核对一致（含 130MB 的版面模型）。

### 3.2 下载流程

```
用户点「下载」
  → 单飞检查（ModelsState 里已有 active 就拒绝，避免两个大文件抢带宽）
  → 对组内每个文件：
       已是目标体积 → 跳过（幂等，支持断点式重试）
       GET 流式读取 → 写入 <models>/.download/<name>.part + 边写边算 SHA-256
       → 体积不符 或 哈希不符 → 删除 .part，报错
       → 通过 → std::fs::rename 到 target（同卷，原子）
  → 进度经 models://progress 事件推送（250ms 节流），命令返回最新快照
```

- **不缓存到临时目录再拷贝**：`.part` 与目标同卷，rename 是原子操作，
  不会出现"半截文件被 OCR 读到"。
- **失败即清理**：任何一步失败都会删掉 `.part`，绝不留下可疑文件。
- **不做断点续传（V1）**：ModelScope 已支持 `Range`，但 V1 采取"整文件重来"，
  简单可靠；`.part` 会被覆盖。是否需要续传取决于 130MB 模型的弱网体验，列入待办。
- 下载中退出应用：`.part` 留在 `.download/` 里，下次下载会覆盖它（无害）。

### 3.3 本地导入（拖放 / 选择文件）

| 规则 | 说明 |
|------|------|
| 识别方式 | 按**文件名**匹配清单（大小写不敏感），不猜内容 |
| 目录 | 传目录时递归查找；符合清单名的文件才会被采用 |
| 校验 | 体积必须完全一致，且 SHA-256 必须一致（130MB 文件约 1–2s） |
| 写入 | **复制**（不移动、不删除用户的文件），落到清单里的 `target` |
| 反馈 | 分别报告"已导入 / 被拒绝（含原因）/ 已忽略（不认识的文件）" |
| 与下载互斥 | 有下载在跑时拒绝导入，避免同时写同一个目标 |

拖放用 Tauri 的 `onDragDropEvent`（能拿到真实路径），并只在「模型」分组可见时生效
（用 `offsetParent` 判断，避免在其它标签页拖 PDF 时误触发）；设置页同时提供
「选择文件 / 选择文件夹」按钮。

### 3.4 IPC 与事件

| 命令 / 事件 | 说明 |
|-------------|------|
| `list_models()` → `ModelsSnapshot` | 组列表 + 每个文件是否已装 + `root`（`<安装目录>\models`，用于界面提示） |
| `download_models({ group })` → `ModelsSnapshot` | 下载并校验整组；失败返回可读错误 |
| `add_local_models({ paths })` → `LocalImportResult` | 本地导入（`spawn_blocking`，含 130MB 哈希） |
| `models://progress` | `{ group, file, downloaded, total }`，250ms 节流 |

"已安装"判定用**文件存在 + 体积一致**（避免每次进设置页都哈希 130MB）；
哈希只在下载/导入时校验，这正是需要它的两个时刻。

### 3.5 与既有设计的关系

- `00016` 的版面模型池：仍然扫描 `<models>/layout/*/layout-meta.json` 发现模型；
  本方案提供的只是"把文件放进去"的手段，不改变发现逻辑。
- 设置页 OCR 分组里原来的**"版面模型未安装"提示条与"从 ModelScope 下载"外链已删除**
  （下载入口统一到「模型」分组）；下拉里对未安装模型仍保留 `model files not installed`
  后缀，用于解释 `paddle` 档为何不生效。
- `00020` 的迁移逻辑（旧 `doccraft_resources/models` → `<安装目录>\models`）与本方案互补：
  老用户升级后模型能自动搬过来，**不需要重新下载**。

## 四、实施清单

| 文件 | 内容 |
|------|------|
| `src-tauri/src/core/model_files.rs` | 新增：清单表、`snapshot` / `download_group`（流式 + 校验 + 原子落盘）/ `add_local`（识别 + 校验 + 复制）、`ModelsState` 单飞；3 个单测（清单自检、文件名映射、URL 形式） |
| `src-tauri/src/core/mod.rs` | 注册 `model_files` 模块 |
| `src-tauri/src/lib.rs` | `list_models` / `download_models` / `add_local_models` 命令 + `ModelsState` 托管 |
| `src-tauri/Cargo.toml` | `sha2` 提升为直接依赖（本就在依赖树里，用于流式哈希） |
| `src/lib/types.ts`、`src/lib/ipc.ts` | `ModelGroupDto` / `ModelProgress` / `ModelsSnapshot` / `LocalImportResult` + 3 个命令 + `onModelProgress` |
| `src/views/settings.tsx` | 新增「模型」分组（`ModelsPanel`）：分组行（名称/体积/状态/下载按钮/进度条）+ 拖放区 + 选择文件/文件夹 + 目标路径提示 |
| `src/i18n/translations.ts` | 新增 `settings.modelFiles*` / `settings.modelGroup*` / 下载导入相关词条；更新版面模型缺失提示 |

## 五、风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| **CDN 对无 `User-Agent` 的请求返回 403** | 下载全挂（URL 看起来完全正确） | 已在 `http_client()` 显式设置 UA；403 错误文案里写明原因（见 §2.1） |
| **ModelScope 的 URL 形式变化** | 下载全挂 | URL 构造集中在 `download_url()`；清单内置，改一处常量即可；校验失败会明确报错而不是静默 |
| OCR 档位的 ModelScope 仓库尚未创建 | 这些组的下载返回 404 | 见 §六 的前置工作；错误信息会带文件名，便于定位 |
| 大文件下载中断（130MB） | 需要重来 | V1 接受；`.part` 不残留坏文件；`Range` 已验证可用，后续可加续传 |
| 用户拖入的文件是改过的/损坏的 | OCR 静默出错 | 体积 + SHA-256 双重校验，不通过即拒绝并说明原因 |
| 模型文件被 OCR 引擎占用时替换 | 写入失败 | 下载/导入均在写目标前校验；失败会明确报错（后续可加"引擎缓存失效"处理） |
| 误判"已安装"（体积相同但内容损坏） | 本地 OCR 报错 | 体积判定是性能取舍；设置页可"重新下载"覆盖，且导入/下载都会做完整哈希校验 |

## 六、前置工作（需要模型作者操作）

1. 在 ModelScope 建一个 OCR 仓库（默认按 `tansen87/PP-OCRv6_mnn` 写死），上传
   `src-tauri/resources/models/` 下的 6 个 `.mnn` 与 3 个 `ppocr_keys_v6_*.txt`
   （**文件名不要改**；`ppocr_keys_v6_medium.txt` 与 small 内容相同，可直接复用同一份）。
   - 仓库名不同 → 改 `core/model_files.rs` 的 `MS_OCR_REPO` 一处即可。
   - **已完成（2026-09-28）**：`tansen87/PP-OCRv6_mnn` 已建好，9 个文件的 `Size` + `Sha256`
     经列表接口逐个核对，与内置清单**完全一致**（另抽样实下 4 个文件验证字节级一致）。
2. 选择 revision 策略：默认用 `master` + 哈希锁定（模型替换后需要发一版应用更新清单）；
   若想彻底钉死 URL，可把 `MS_REVISION` 改成具体 commit（API 的 `files` 接口会给出）。

## 七、验收清单

- [ ] 全新安装（无模型）→ 设置页「模型」分组列出 4 组，均为"未安装"，显示体积。
- [ ] 点 tiny 组「下载」→ 进度条推进（事件 ≤4 次/秒）→ 变为"已安装"；
      本地 OCR（tiny 档）立即可用。
- [ ] 下载 small / medium 后切换 `ocrModelSize` 三档都能跑。
- [ ] 下载版面模型后可切换到 `ocrLayoutMode = paddle`，`list_layout_models` 能看到 PP-DocLayoutV3。
- [ ] 把 `layout-meta.json` 手工改一个字节再拖入 → 被拒绝并提示校验失败（原文件不被破坏）。
- [ ] 拖入整个 `models` 文件夹 → 命中的文件导入，未识别的文件被忽略并计数。
- [ ] 拖放时切换到其它设置分组/其它工作区标签 → 不会误触发导入。
- [ ] 断网下载 → 明确报错，`<models>/.download/` 不留坏文件。
- [ ] 下载完成后再点「重新下载」→ 覆盖成功；重复点击不会并发出两个下载。
- [ ] `pnpm exec tsc --noEmit`、`cargo check`、`cargo test --lib` 全绿。

## 八、参考

- ModelScope 文件列表 API（含 `Sha256` / `Size` / `Revision`）：
  `https://www.modelscope.cn/api/v1/models/{owner}/{repo}/repo/files?Revision=master`
- ModelScope 单文件下载（普通 + LFS 通用，支持 `Range`）：
  `https://www.modelscope.cn/api/v1/models/{owner}/{repo}/repo?Revision={rev}&FilePath={path}`
- 相关设计文档：
  [00016_local-ocr-layout-analysis.md](./00016_local-ocr-layout-analysis.md)（版面模型池发现机制）、
  [00020_update-check-and-install-layout.md](./00020_update-check-and-install-layout.md)（模型不随包 + 旧目录迁移）、
  [00021_auto-download-install.md](./00021_auto-download-install.md)（同为"下载 + 校验"模式，进度节流复用）
