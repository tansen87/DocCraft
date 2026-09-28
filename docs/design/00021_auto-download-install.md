# 一键自动更新（下载 → 验签 → 安装 → 重启）方案

状态标记：◐ 已实施（2026-09-28）

> **结论**：
> 1. 用官方 **`tauri-plugin-updater` 2**，仍然**由 Rust 侧驱动**——`capabilities`
>    里不放开任何 `updater:*` 权限，WebView 无法自行触发安装。
> 2. **更新源仅 GitHub**：endpoint =
>    `https://github.com/tansen87/DocCraft/releases/latest/download/latest.json`
>    （静态清单，不消耗 `api.github.com` 限额），安装包 URL 由清单的
>    `platforms["windows-x86_64"].url` 指定。
> 3. **强制 minisign 签名**（插件无法关闭校验）：公钥内置在
>    `tauri.conf.json`，私钥只存在于本机 `~/.tauri/` 与 CI Secret；
>    `Update::download` 内部完成验签，校验失败直接中止，绝不会执行未签名的包。
> 4. **交互**：顶栏绿点 → 对话框「立即更新」→ 下载（进度条 + 节流事件）→
>    验签 → 安装（`plugins.updater.windows.installMode = passive`）→ 应用自动退出
>    → 安装器接管并**自动重启**新版本 → 首启提示「已更新到 vX.Y.Z」。
> 5. **护栏**：安装位置不可写（Program Files 等）时**不显示**自动更新按钮，只给
>    手动下载；有转换任务在跑时二次确认；拒绝降级（默认 comparator 只接受更高版本）。
> 6. **发布**：新增 `.github/workflows/release.yml`（`tauri-action`）——打 tag 自动
>    构建 + 签名 + 生成 `latest.json` + 建**草稿** Release；草稿必须**手动发布**，
>    因为 `releases/latest` 不会命中草稿或预发布。

## 一、背景与范围

`00020_update-check-and-install-layout.md` 落地的是"**只检查** + 用户手动下载 +
安装器布局（`currentUser` / 强制 `\DocCraft` / hooks 校验 / 模型不随包）"。
本方案在其上补上"点一下自动下载并安装"，**安装器那部分完全复用**，不改一行 NSIS 逻辑。

**目标**

1. 一次点击完成：下载 → 验签 → 安装 → 重启，不需要用户打开浏览器。
2. 全流程免管理员（沿用 `installMode: currentUser`）。
3. 安装包必须通过 minisign 校验；失败或不匹配一律拒绝。
4. 沿用现有 UI 语言：绿点提示、非阻塞、可跳过版本、离线静默。
5. 有独立可用的发布链路（CI），且版本号不会与 tag 脱节。

**非目标**

- 增量/差分更新、断点续传（插件不支持）。
- Beta / 灰度 / 多渠道（只维护 stable 的 `latest.json`）。
- 静默**强制**更新（永远由用户点）。
- 更新包做镜像加速（更新源仅 GitHub；系统代理由插件的 `system-proxy` 特性自动生效）。
- macOS / Linux 的自动重启（`targets = ["nsis"]`，见 §3.6 注）。

## 二、关键技术事实（已核对上游实现）

| 事实 | 说明 | 影响 |
|------|------|------|
| `Update::download(on_chunk, on_finish)` | 文档原文"Downloads the updater package, **verifies it** then return it as bytes" | 验签在下载内完成；我们只持有验签通过的字节 |
| `Update::install(bytes)` | **Windows：启动安装器后 `std::process::exit(0)`**；macOS/Linux 需自行 relaunch | 一键流程在 Windows 上"应用退出 → 安装器接管"，命令不会返回 |
| `restart_after_install(bool)` | 默认 `true`：Windows 安装器装完重启应用（NSIS 模板对静默/被动安装识别 `/R`） | 不需要 `tauri-plugin-process` |
| `UpdaterBuilder` | `endpoints` / `pubkey` / `timeout` / `on_before_exit` / `installer_arg(s)` / `configure_client` / `version_comparator` | 只需 `timeout`，其余走 `tauri.conf.json` |
| `plugins.updater.windows.installMode` | `quiet`（无 UI，且**不能请求管理员**）/ `passive`（显示系统进度小窗，无需交互）/ `basicUi` | **选 `passive`**：自动完成、失败可见；`quiet` 失败时用户无从察觉 |
| `createUpdaterArtifacts: true` | Windows 产物 = `DocCraft_x.y.z_x64-setup.exe` + `.exe.sig` | 安装包本身即更新包，无需额外压缩包 |
| `latest.json` 必填 | `version` + `platforms[target].{url, signature}`；`signature` 是 `.sig` **文件内容**（不是 URL）；`notes` 由 `tauri-action` 用 Release body 填充 | `notes` 正好复用现有 markdown 对话框 |
| 插件默认特性 | `rustls-tls` + `system-proxy` + `zip`(v1 兼容) | 本项目改用 `native-tls` + `system-proxy`，去掉 `zip`（与已有 `reqwest` 共用 TLS 栈） |
| 端点语义 | 静态清单：无更新返回 `204` 或版本不高于当前 → `check()` 返回 `None`；默认 comparator 只接受**更高**版本（不降级） | 天然防降级攻击 |

## 三、设计

### 3.1 状态机

```
启动 ~3s ──▶ Checking ──┬─ 无更新 / 离线 / 超时 ──▶ Idle（静默）
                        └─ 有更新 ──────────────▶ Available（绿点亮）

Available ──用户点「立即更新」──▶ Downloading（0→100%，节流事件）
                                    │ 验签失败 / 下载失败
                                    ├──────────────▶ Error（弹窗给「重试」/「手动下载」）
                                    ▼
                                 Installing ──▶ 应用退出 ──▶ 安装器（passive）──▶ 自动重启新版本
                                                                                    └─▶ 首启「已更新到 vX.Y.Z」

旁路：Skipped（跳过此版本，持久化）；任意阶段可用「手动下载」兜底
```

### 3.2 后端（`core/update.rs`）

`UpdateSnapshot`（唯一真源，事件 `update://state` 推全量快照）：

```rust
pub struct UpdateSnapshot {
  phase: String,              // idle|checking|available|downloading|installing|skipped|error
  current_version: String,    // 运行中版本
  version: Option<String>,    // 清单里的新版本
  date: Option<String>,       // YYYY-MM-DD
  notes: Option<String>,      // 更新说明（markdown）
  release_url: String,        // 手动下载兜底入口
  error: Option<String>,
  downloaded_bytes: u64,
  total_bytes: Option<u64>,
  auto_install: bool,         // 安装位置是否可自更新（见下）
}
```

| 命令 | 入参 | 行为 |
|------|------|------|
| `check_for_update` | `{ force? }` | 走插件 `check()`；失败写 `error`，不抛错（手动检查才展示） |
| `get_update_state` | - | 首帧拉当前快照 |
| **`update_now`** | - | **下载 + 验签 + 安装**（Windows 上不返回） |
| `skip_update_version` | `{ version }` | 持久化跳过版本 |
| `clear_skipped_version` | - | 恢复提醒 |
| `take_version_notice` | - | 一次性消费"已更新到 vX"提示（拉取式，避免 `setup()` 期事件竞态） |

实现要点：

- **进度节流**：`on_chunk` 里累计字节，仅在距上次 emit ≥ `PROGRESS_THROTTLE_MS`
  (250ms) 时推送，避免快速下载刷爆 IPC；`total` 只在服务器给 `Content-Length` 时存在，
  前端据此决定显示"x%"还是"正在下载…"。
- **单飞 + 不泄漏 busy**：`check` 与 `update_now` 共用一个 `busy` 标志；
  `update_now` 用 `BusyGuard`（`Drop` 里复位）保证任何早退路径都不会把状态卡死。
- **复用 `check` 的结果**：`check` 命中时把 `Update` 存进状态，用户点「立即更新」
  时直接复用（`resolve_update`），不再二次请求清单。
- **`install_dir_writable()`**：拒绝 `%ProgramFiles%` / `%ProgramFiles(x86)%` /
  `%windir%` / `%ProgramData%`（整段、大小写不敏感的路径前缀比较，与
  `installer-hooks.nsh` 的守卫同一套规则），再写探针文件确认可写。
  不可写时 `auto_install = false` → UI 只给「手动下载」，**不显示注定失败的按钮**。
- **不加 `updater:*` 权限**：全部经 Rust 命令，WebView 无法直接 download/install。

### 3.3 前端

- 顶栏绿点保持；`downloading` / `installing` 期间图标转圈，tooltip 显示百分比。
- 对话框：更新说明（markdown，与之前一致）→ 点「立即更新」后原地换成**进度条 +
  `43%` + `12.3 MB / 27.1 MB`**，按钮禁用并显示「正在安装…DocCraft 即将自动重启」。
- 按钮：`跳过此版本` / `稍后` / `立即更新`（`autoInstall=false` 时降级为
  `手动下载` + `GitHub` 两个按钮）。
- **任务保护**：`useGlobalTasks()` 发现有待运行任务时显示警告条，主按钮变
  「仍要更新」，**需要点第二次**才真正开始——避免静默杀掉正在跑的转换/OCR 批次。
- 设置页「更新」分组不变（当前版本 / 立即检查 / 启动检查开关 / 已跳过版本）。

### 3.4 签名与密钥

```bash
# 一次性生成（本仓库已生成，私钥不进仓库）
pnpm tauri signer generate -w ~/.tauri/doccraft.key -p ""
# 公钥（`~/.tauri/doccraft.key.pub` 的内容）写入 tauri.conf.json 的 plugins.updater.pubkey
# 私钥 → 离线备份 + CI Secret（TAURI_SIGNING_PRIVATE_KEY）
```

| 项 | 约定 |
|----|------|
| 公钥 | 明文写在 `tauri.conf.json`（可公开，随二进制分发） |
| 私钥 | `~/.tauri/doccraft.key`（**不入库**，`.gitignore` 已加 `*.key`）；必须离线备份 |
| 密码 | 本次生成**不带密码**（少一个 CI Secret）；若要加密码，同步配 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |
| 丢失后果 | **无法再向已安装用户推送任何更新**（内置公钥无法匹配新签名）。补救：发一个"过渡版本"——用旧私钥签、内含新公钥，之后才能切到新私钥 |
| 泄露后果 | 任何人都能签出被接受的更新包；需立刻轮换（同"过渡版本"流程） |
| 本地构建 | 因为开了 `createUpdaterArtifacts`，`pnpm tauri build` **需要**签名私钥，否则构建在最后一步失败（`A public key has been found, but no private key`）。实测 `tauri-cli` 2.x 的构建路径**只认 `TAURI_SIGNING_PRIVATE_KEY`**（密钥内容），`TAURI_SIGNING_PRIVATE_KEY_PATH` 虽然出现在 `tauri signer generate` 的提示里，但 `tauri build` 不读它。`pnpm tauri dev` 不受影响（不打包） |
| 签名依赖 `wmic.exe` | 实测（2026-09-28）：`tauri signer sign` / 构建的签名阶段在 Windows 上会调用 `wmic.exe`。若该程序被安全策略禁用（受限环境、部分精简/加固系统），签名会**失败甚至长时间卡住**（CLI 已打印 `Signing without password.`，说明不是密码问题，而是在等被拦的子进程） | 发布统一走 GitHub Actions（runner 环境完整）；本地只跑 `pnpm tauri dev`，或接受未签名构建（不可用于自动更新分发） |

### 3.5 发布流程

```
改版本号（src-tauri/tauri.conf.json，单一来源）
  → 打 tag v0.2.1 → push
  → GitHub Actions：校验 tag == tauri.conf.json 版本 → 构建 → 签名
      → 产出 DocCraft_0.2.1_x64-setup.exe / .exe.sig / latest.json
      → 建**草稿** Release 并上传
  → 人工检查后**发布**（草稿/预发布不会被 releases/latest 命中）
  → 老版本客户端下一次启动检查即可看到绿点
```

CI 前置（一次性）：仓库 Settings → Secrets 添加
`TAURI_SIGNING_PRIVATE_KEY`（私钥内容），如设了密码再加
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。

> 实测提示（2026-09-28）：签名阶段会调用 `wmic.exe`，在禁用该程序的环境里会卡住。
> 本机的受限沙箱就是这种情况（构建到签名步骤后长时间无响应，CLI 已提示
> `Signing without password.`），因此**本次未能在本机产出 `.exe.sig`**；
> 请在自己的正常 shell 或 CI 上执行发布构建。所有其它校验
> （`tsc --noEmit`、`cargo check`、`cargo test --lib`、以及不含签名的 NSIS 打包）
> 均已通过。

无 CI 时也能手动发一版（备查）：

```bash
# 私钥内容通过环境变量传入（PATH 变体在 tauri build 上不生效，见 §3.4）
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/doccraft.key)" pnpm tauri build
# 产物：target/release/bundle/nsis/{DocCraft_0.2.1_x64-setup.exe, .exe.sig}
# latest.json 手写（signature = .sig 文件内容）后连同两个产物一起上传到 Release
gh release create v0.2.1 --title "DocCraft v0.2.1" --notes "..." \
  src-tauri/target/release/bundle/nsis/DocCraft_0.2.1_x64-setup.exe \
  src-tauri/target/release/bundle/nsis/DocCraft_0.2.1_x64-setup.exe.sig \
  latest.json
```

### 3.6 与 00020 的不变式一致

- 更新走的还是**同一个安装器**：`installMode: currentUser`（免管理员）、
  钩子强制 `\DocCraft`、系统位置拦截、写探针校验，全部照旧生效。
- `passive` 模式**不显示目录页**（模板对 `/P` 跳过所有页面），`$INSTDIR` 由
  `RestorePreviousInstallLocation` 从注册表恢复 → 原地升级，不会另装一份。
- 安装目录下的 `data/`（设置 + DPAPI 密钥）与 `models/` 不受影响：安装器只删自己
  安装的文件。
- 更新完成后 `last_run_version` 机制仍给出「已更新到 vX.Y.Z」提示。
- 注：macOS/Linux 若要自动重启，需要额外引入 `tauri-plugin-process` 并调用
  `relaunch()`；当前 `targets = ["nsis"]`，不在范围内。

## 四、实施清单

| 文件 | 内容 |
|------|------|
| `src-tauri/Cargo.toml` | `tauri-plugin-updater`（`default-features = false` + `native-tls` + `system-proxy`） |
| `src-tauri/tauri.conf.json` | `bundle.createUpdaterArtifacts: true`；`plugins.updater`：`pubkey` / `endpoints`（GitHub latest.json）/ `windows.installMode: passive` |
| `src-tauri/src/lib.rs` | 注册 updater 插件；新增 `update_now` 命令 |
| `src-tauri/src/core/update.rs` | 重写为插件驱动：`fetch_update` / `check` / `update_now`（下载+验签+安装）/ `install_dir_writable` / `path_is_inside`（含单测）/ 进度节流 / `BusyGuard` |
| `src/lib/types.ts`、`src/lib/ipc.ts` | `UpdateSnapshot` 扩展（phase/downloadedBytes/totalBytes/autoInstall）+ `updateNow()` |
| `src/components/header-actions.tsx` | 对话框内进度条与状态文案；一键更新；任务运行中二次确认；`autoInstall=false` 降级为手动下载 |
| `src/i18n/translations.ts` | `update.installNow` / `downloading*` / `installing` / `busyWarning` / `confirmInstall` / `manualDownload` / `noAutoInstall` / `installFailed` 等词条 |
| `.github/workflows/release.yml` | 新增：tag 校验 + 构建 + 签名 + `tauri-action` 建草稿 Release（含 `latest.json`） |
| `.gitignore` | `*.key` / `*.key.pub`（签名私钥绝不入库） |

## 五、风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| **私钥丢失 / 泄露** | 无法推送更新 / 任何人可签更新 | 离线备份；`.gitignore` 兜底；轮换走"过渡版本"（旧私钥签新公钥） |
| 自动更新打断正在跑的任务 | 用户丢结果 | 任务运行时警告 + 二次确认；更新后仍可重跑（本地输入文件不受影响） |
| 安装器失败（杀软拦截、目录被占用） | 应用不重启，用户以为软件崩了 | `passive` 显示系统进度窗，失败可见；文档给出"重新打开 DocCraft 检查版本"的建议；必要时改为 `basicUi` 让用户看到错误 |
| 用户装在 Program Files（历史机器级安装） | 自动更新必然失败 | `install_dir_writable()` → `autoInstall=false` → UI 只给手动下载 |
| GitHub 不可达 | 检查/下载失败 | `system-proxy` 让系统代理生效；失败静默；手动下载兜底（不做镜像，符合约束） |
| 降级攻击（推旧版本） | 用户被回滚到有漏洞版本 | 插件默认 comparator 只接受更高版本；不启用 `allowDowngrades` |
| CI 缺 Secret | 构建失败 / 出不了签名产物 | workflow 直接失败（快速暴露），文档列出所需 Secret |
| 签名步骤依赖 `wmic.exe` | 受限/加固系统上本地构建卡在签名阶段 | 发布统一走 CI；(可选) 在能跑签名步骤的机器上构建 |
| tag 与包内版本不一致 | 客户端认为"版本没变"，更新不生效 | CI 第一步校验 tag == `tauri.conf.json` version，不一致直接 fail |
| 更新包体积 | 影响弱网体验 | 不含模型，实测安装包 ~6MB（00020 §3.4.2） |

## 六、验收清单

- [ ] 装 0.2.0 → 发布 0.2.1 → 启动 0.2.0：约 3s 后出现绿点，点开对话框显示 0.2.1 的更新说明。
- [ ] 点「立即更新」：对话框原地显示进度条与 `x%`（事件频率 ≤ 4 次/秒）→ 变为「正在安装…」
      → 应用退出 → 系统进度窗（passive）→ **自动重启到 0.2.1** → 出现「已更新到 v0.2.1」。
- [ ] 全程**不弹 UAC**；升级后安装目录仍是原来那个（注册表 `InstallLocation` 未变）。
- [ ] 升级后 `data/`（设置、DPAPI 密钥）与本地 `models/` 内容保持不变。
- [ ] 篡改 `latest.json` 的 `signature` 或替换安装包 → 拒绝安装并提示「更新失败」（**不会执行任何未签名包**）。
- [ ] 远端版本低于当前 → 不提示更新（`check()` 返回 `None`）。
- [ ] 把 exe 放到 `%ProgramFiles%` 模拟 → 对话框不显示「立即更新」，只给「手动下载」。
- [ ] 转换批次运行中点「立即更新」→ 显示警告，按钮变「仍要更新」，第二次点击才开始。
- [ ] 断网 / 10s 超时启动 → 无 toast、无卡顿，功能正常。
- [ ] 点「跳过此版本」→ 绿点消失；设置页清除后恢复。
- [ ] `pnpm exec tsc --noEmit`、`cargo check`、`cargo test --lib` 全绿；
      带 `TAURI_SIGNING_PRIVATE_KEY` 的 `pnpm tauri build` 产出 `.exe` + `.exe.sig`
      （**需在正常 shell / CI 上验证**：签名阶段依赖 `wmic.exe`，受限环境会卡住）。
- [ ] CI：打 tag → 草稿 Release 含 `-setup.exe`、`.exe.sig`、`latest.json`；
      发布后 `https://github.com/tansen87/DocCraft/releases/latest/download/latest.json` 可取到。

## 六、症状 → 原因对照（实测，排障用）

| 症状 | 原因 | 处理 |
|------|------|------|
| 检查更新报 `Could not fetch a valid release JSON from the remote`（插件 `Error::ReleaseNotFound`） | `releases/latest/download/latest.json` **404**：最新**正式**发布里没有该附件——要么还没用带签名的流程发过版，要么最新 release 还是草稿/预发布（`releases/latest` 跳过这两类） | 用 §3.5 的流程发一版（草稿→手动发布）。UI 已把该情况识别为 `noManifest` 并给出本地化说明（`update.noManifest`），不再显示插件原文 |
| 检查更新通过但一直显示"已是最新" | 清单里的 `version` **不高于**当前运行版本（默认 comparator 只接受更高版本） | 发版前把 `tauri.conf.json` 的版本号一起提升 |
| 构建到签名步骤报 `A public key has been found, but no private key` | 没设 `TAURI_SIGNING_PRIVATE_KEY` | 见 §3.4 的构建命令 |
| 构建在签名步骤长时间无响应 | 环境禁用了 `wmic.exe`（签名会调用它） | 改用 CI 发布 |
| 下载完成后报签名/校验相关错误（`Minisign` 等） | 安装包与清单里的 `signature` 不匹配（换包、改清单、或换了私钥） | 用同一私钥重新构建并**同时更新** `latest.json` 的 `signature` 与 `url` |

> 仓库现状（2026-09-28）：已有的 `v0.2.0` / `v0.1.0` 都是签名流程之前发布的，
> 附件里只有 `-setup.exe` / `.msi` / `portable.zip`，**没有 `latest.json`**，
> 所以更新通道尚未可用；需要按 §3.5 发一版带签名的正式发布。

## 七、参考

- Tauri 文档 · Updater 插件（配置、签名、`latest.json` 格式、Windows `installMode`）：
  <https://v2.tauri.app/plugin/updater/>
- `tauri-plugin-updater` Rust API（`Update::download/install`、`UpdaterBuilder`、特性列表）：
  <https://docs.rs/tauri-plugin-updater/latest/tauri_plugin_updater/>
- Tauri 文档 · Windows Installer（`installMode: currentUser` 免管理员、`/R` 重启标志、
  `MUI_PAGE_DIRECTORY` 在被动模式下跳过）：<https://v2.tauri.app/distribute/windows-installer/>
- `tauri-apps/tauri-action`（自动生成 `latest.json`、上传签名产物）：
  <https://github.com/tauri-apps/tauri-action>
- 相关设计文档：[00020_update-check-and-install-layout.md](./00020_update-check-and-install-layout.md)
  （安装器布局、`\DocCraft` 强制、模型不随包；本方案复用它）
