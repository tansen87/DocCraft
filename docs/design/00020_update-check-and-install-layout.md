# 更新检查（启动静默检测 + 绿点提示）与安装器布局方案

状态标记：◐ 已实施（2026-09-28）

> **已落地**（代码见 §四的实施计划；实施中的三处偏差见文末"实施记录"）：
> Rust 侧 `core/update.rs` 重写为 `UpdateSnapshot` + `UpdateState`，`lib.rs` 的
> `setup()` 中延迟 3s 异步检查、事件 `update://state`、5 个 IPC 命令（含
> `take_version_notice`）；`core/migrate.rs` 完成旧 `doccraft_resources/` 布局的
> 幂等迁移（含单测）；`core/mod.rs`/`settings.rs`/`ocr.rs`/`layout.rs` 与
> `build.rs` 完成资源路径扁平化；`tauri.conf.json` 配置 NSIS
> `currentUser` + `installerHooks` + 中英语言、`targets` 收敛为 `nsis`，
> **模型不进安装包**（§3.4.2）；
> `windows/installer-hooks.nsh` 实现 `$INSTDIR` 规范化与可写性/系统位置校验；
> 前端顶栏绿点 + 更新对话框 + 设置页「更新」分组 + 首启"已更新到 vX"提示；
> `pnpm exec tsc --noEmit`、`cargo check`、`cargo test --lib`（138 项）全绿。
>
> **待实测**（需干净环境，本机沙箱无法写入注册表/开始菜单）：§六验收清单中的
> 安装/卸载、免 UAC、`D:\test` → `D:\test\DocCraft`、迁移实跑。
> 已实测：`pnpm tauri build` 产出 NSIS 安装包且钩子通过 `makensis` 编译，
> 安装包体积 **6.0MB**（不含模型）。

> **结论**（相对上一版"自动更新"设想的**范围收缩**：不下载、不安装、不签名）：
>
> 1. **只检查，不下载**：沿用现有 `core/update.rs` 的 GitHub Releases 检查，
>    不引入 `tauri-plugin-updater`、不需要签名密钥与 `createUpdaterArtifacts`。
>    更新包由用户在浏览器里从 GitHub Release 手动下载、双击安装。
> 2. **检查时机**：从 `HeaderActions` 的挂载期调用改为 **Rust `setup()` 内延迟
>    ~3s 异步执行、每会话一次**，结果经 `update://state` 事件推给前端；
>    渲染路径上零网络调用（不卡 UI 的落地方式见 §3.1）。
> 3. **提示**：有新版本时，顶栏「检查更新」按钮**右上角亮一个 6px 小绿点**；
>    点它打开对话框看更新说明 + 「前往 GitHub 下载」；可「跳过此版本」。
> 4. **安装器**：`installMode: "currentUser"` 保证**免管理员**；保留目录选择页，
>    但无论用户选哪儿，`$INSTDIR` 一律规范化为 **`<选定路径>\DocCraft`**
>    （幂等，重复安装不会变成 `DocCraft\DocCraft`）；只允许用户可写位置，
>    选到 `Program Files` 等在安装前拦截并提示。
> 5. **资源布局扁平化**：**取消 `doccraft_resources` 这一层**，其下的目录与
>    exe 同级——`<安装目录>\models\`（模型，**安装包不带**，由用户后续
>    在线安装或拖放获取）与 `<安装目录>\data\`
>    （运行时生成：`ocr-config.json` / `app-settings.json` / 用量日志）；
>    首次运行做一次性迁移，把旧 `doccraft_resources` 下的内容同步到新位置，
>    用户手动下载的模型不丢。

## 一、需求与现状

### 1.1 需求（用户原话转写）

| # | 需求 | 落地位置 |
|---|------|----------|
| 1 | 更新包**需要用户手动下载**，应用不做下载/安装 | §3.1 / §3.2 |
| 2 | **每次启动**只检查有无更新（不做定时轮询） | §3.1 |
| 3 | 有更新时**图标右上角显示小绿点**（不用弹窗打断） | §3.2 |
| 4 | 安装时**无论用户选哪个路径，都要追加 `DocCraft` 目录**，避免整个文件夹被删 | §3.3 |
| 5 | 把原 `doccraft_resources` 里的目录**同步到 `DocCraft` 目录里**（与 exe 同级） | §3.4 |

### 1.2 现状盘点

| 位置 | 现状 |
|------|------|
| `src-tauri/src/core/update.rs` | 请求 `api.github.com/repos/tansen87/DocCraft/releases/latest`（10s 超时），解析 `tag_name`/`name`/`body`/`html_url`，自写 `is_newer()` 点分比较 |
| `src/lib/ipc.ts` | `checkForUpdate()` → `invoke("check_for_update")`，返回 `UpdateInfo \| null` |
| `src/components/header-actions.tsx` | **组件挂载时**调用一次（模块级 `cachedCheck` 保证每会话一次）；有更新显示琥珀色角标；对话框渲染 release notes，按钮跳 GitHub / **Gitee** Release 页 |
| 资源根目录 | `core::get_resources_dir()` = `<exe_dir>/doccraft_resources`（`core/mod.rs:19`） |
| 只读模型 | `<exe_dir>/doccraft_resources/models/`：`PP-OCRv6_{tiny,small}_*.mnn`、`ppocr_keys_v6_*.txt`、`models/layout/<模型>/` |
| **运行时生成** | `<exe_dir>/doccraft_resources/data/`（`settings::data_dir()`，`settings.rs:15`）：`ocr-config.json`（含 DPAPI 密文密钥）、`app-settings.json`、`usage-*.jsonl`（`usage_stats.rs:18` 复用 `data_dir`） |
| 其他运行时数据 | 截图 PNG → `app_data_dir()/screenshots`（`snip.rs:265`，已在安装目录之外，不受影响） |
| 资源分发方式 | 没有接进 bundler 的 `resources`；`build.rs::sync_resources()` 把 `src-tauri/resources/models` 镜像到 `<target>/<profile>/models`，仅服务 dev / 非捆绑构建。**安装包不带模型**（2026-09-28 决定，见 §3.4.2） |
| 打包 | `bundle.targets: "all"`（msi + nsis）；仓库**无 `.github/`**，无 CI；无签名配置 |
| 入库的模型文件 | 仅 `small` / `tiny` 两档的 det+rec、`ppocr_keys_v6_{small,tiny}.txt`、`layout/PP-DocLayoutV3/layout-meta.json`（`src-tauri/.gitignore` 排除 `**/*.mnn`，medium 档与 `PP-DocLayoutV3.mnn` **不在版本控制内**） |

### 1.3 上游 NSIS 模板事实（设计依据，已核对源码）

| 事实 | 细节 | 对本方案的影响 |
|------|------|----------------|
| 目录选择页默认存在 | 模板无条件插入 `!insertmacro MUI_PAGE_DIRECTORY`（仅 `/P` 被动模式经 `SkipIfPassive` 跳过） | 用户确实能改安装路径，所以"强制追加 `DocCraft`"是必要动作 |
| `$INSTDIR` 计算 | `InstallDir "placeholder\<ProductName>"`；`.onInit` 里**仅当 `$INSTDIR` 仍等于占位值**才按 `INSTALLMODE` 赋值（currentUser → `$LOCALAPPDATA\<ProductName>`），随后 `RestorePreviousInstallLocation` 会**用注册表里上次的安装目录覆盖**它 | ① 用户经目录页/`/D=` 选的路径不会被覆盖；② 升级/复装时 `$INSTDIR` 来自注册表（已是 `…\DocCraft`）→ 追加逻辑**必须幂等** |
| 钩子插入点 | `Section Install`：`SetOutPath $INSTDIR` → **`NSIS_HOOK_PREINSTALL`** → 检查进程 → 拷文件 | 改 `$INSTDIR` 只能在钩子里做，且**必须自己重新 `SetOutPath`**（`File` 指令按当前 `SetOutPath` 落盘） |
| 注册表写入时机 | `WriteRegStr "${MANUPRODUCTKEY}" "" $INSTDIR`、`InstallLocation`、`UninstallString`、`DisplayIcon` 都在钩子**之后** | 钩子里改 `$INSTDIR` 后，注册表/卸载器天然记录**最终**路径，无需额外修补 |
| 卸载删除范围 | 删自己的 exe → `{{#each resources}}` 各文件 → `{{#each resources_ancestors}} RMDir /REBOOTOK "$INSTDIR\<祖先>"` → `RMDir "$INSTDIR"`（**非递归**，非空则保留）；"删除应用数据"时额外 `RmDir /r "$APPDATA|$LOCALAPPDATA\$BUNDLEID"` | 历史上的 `RMDir /R /REBOOTOK "$INSTDIR"`（会连用户选的整目录一起删）**已在上游 commit `1cf01f7` 修复**，当前 Tauri 2 已含该修复——详见 §3.3.4 的风险说明 |
| 更新标志 | 模板解析的是 `/UPDATE`（不是 `/UPDATER`）与 `/P`（被动）；`/UPDATE` 时不执行卸载流程、不重建快捷方式 | 手动下载安装时若走静默升级，用 `/S /UPDATE` 更安全（保留快捷方式与注册表） |

## 二、目标与非目标

**目标**

1. 启动后自动检查一次，结果只通过轻量 UI（绿点）表达，绝不弹窗打断。
2. 检查过程不进入前端渲染路径，不产生可见卡顿。
3. 提供明确的"去哪儿下载"入口（GitHub Release 页），并支持"跳过此版本"。
4. 安装包**始终**装进专属的 `DocCraft` 目录，且不需要管理员权限。
5. 资源与运行时数据布局扁平化（与 exe 同级），并保证升级/换目录后**用户数据与手动下载的模型不丢**。

**非目标（本期）**

- 应用内下载、增量下载、后台静默安装（本期明确由用户手动下载安装）。
  > **已变更**：应用内"一键下载 + 验签 + 安装"随后由
  > [00021_auto-download-install.md](./00021_auto-download-install.md) 落地
  > （引入 `tauri-plugin-updater` + minisign 签名 + CI 发布链路）。
  > 本文档的安装器部分（`currentUser` / 强制 `\DocCraft` / hooks / 模型不随包）
  > 被 00021 原样复用，无需修改。
- 签名密钥 / `createUpdaterArtifacts`（本期不引入；见上一行的后续文档）。
- 定时轮询更新（每次启动一次即可）。
- 自动更新 GitHub 之外的任何源（更新源仅 GitHub；Gitee 入口从更新对话框移除）。
- 把 `data/` 迁到 `%APPDATA%`（本期按需求放在安装目录，风险见 §5）。

## 三、设计

### 3.1 更新检查：时机与"不卡 UI"

```
Rust setup()
  └─ std::thread::spawn
        ├─ sleep(~3s)                     ← 避开首屏渲染 + 设置加载 + 资源扫描的 IO 高峰
        └─ tauri::async_runtime::block_on(async {
              if !settings.autoCheckUpdate() { return; }      ← 设置项可关
              let snap = update::check(app, /*force=*/false).await;  ← 10s 超时，失败静默
              state.set(snap); emit("update://state", snap);
           })
```

| # | 手段 | 说明 |
|---|------|------|
| 1 | 触发点搬到 Rust | 删除 `header-actions.tsx` 里的 mount 期 `checkForUpdate()`；前端只订阅事件 + 首帧拉一次 `get_update_state`，渲染路径无网络副作用 |
| 2 | 延迟 ~3s 再发请求 | 不引入 `tokio` 直接依赖：`std::thread::spawn` 里 `sleep` 后 `tauri::async_runtime::block_on` |
| 3 | 每会话一次 | 与现有 `cachedCheck` 语义一致，迁移到 Rust 侧 `UpdateState`（`checked: bool`）；手动检查（`force=true`）可绕过 |
| 4 | 超时 + 静默失败 | `reqwest` 客户端保持 10s 超时；离线 / 404 / 解析失败一律只落内部状态，不 toast、不写日志噪音（手动检查才提示错误） |
| 5 | 只发必要事件 | 仅在窗口存在且可见时 `emit`；`update://state` 携带**全量快照**（前端只替换，不累计） |
| 6 | 与转换任务无关 | 检查是一次只读 HTTP 请求（无磁盘、无 CPU 密集），因此不需要与 worker pool 互斥；唯一约束是"不在渲染路径上" |

**状态机 / 数据模型**（Rust 侧为唯一真源）：

```
Idle ──启动延迟到期 / 手动点按钮──▶ Checking ──┬─ 无更新 ──▶ Idle
                                              ├─ 有更新 ──▶ Available（绿点亮）
                                              └─ 失败   ──▶ Error（静默；手动检查时提示）

Available ──用户点「跳过此版本」──▶ Skipped（绿点灭，持久化 updateSkippedVersion）
```

```rust
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
  phase: String,            // "idle" | "checking" | "available" | "skipped" | "error"
  current_version: String,  // app.package_info().version
  version: Option<String>,  // 远端版本（去掉前缀 v）
  date: Option<String>,     // 发布时间（可选）
  notes: Option<String>,    // Release body（markdown）
  release_url: String,      // 固定 = https://github.com/tansen87/DocCraft/releases/latest
  error: Option<String>,    // 仅手动检查时展示
}
```

| IPC | 入参 | 出参 | 说明 |
|-----|------|------|------|
| `check_for_update` | `{ force?: bool }` | `UpdateSnapshot` | 沿用旧命令名；语义变为"触发检查 + 返回快照" |
| `get_update_state` | - | `UpdateSnapshot` | 前端首帧拉初始值，避免订阅前的中间态缺失 |
| `skip_update_version` | `{ version }` | `UpdateSnapshot` | 写 `updateSkippedVersion`，置 `skipped` |
| `clear_skipped_version` | - | `UpdateSnapshot` | 设置页"重新提醒我" |

**为什么继续用 `api.github.com` 而不是静态 `latest.json`**：静态清单是 `tauri-action`
配合 `createUpdaterArtifacts` 才产出的，本方案不引入 updater 插件，所以没有必要多维护一个
文件；`releases/latest` 的免认证限额是 60 次/时/IP，而本应用每台机器**每会话最多 2 次**
（启动 1 次 + 手动 1 次），风险可忽略。若将来发现共享出口 IP 有异常，再切静态清单。

### 3.2 绿点提示（UI）

**位置**：顶栏右侧「检查更新」按钮（现 `CloudDownload` 图标）右上角；用户已确认。

```tsx
// header-actions.tsx（示意）
<Button variant="ghost" size="icon" className="relative" onClick={onClick}>
  <CloudDownload className={checking ? "size-4 animate-pulse" : "size-4"} />
  {hasUpdate && (
    <span
      className="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-green-500
                 ring-2 ring-background dark:ring-background"
      aria-hidden
    />
  )}
</Button>
```

| 项 | 规则 |
|----|------|
| 视觉 | 6px 实心圆（`bg-green-500`），外加 2px 与背景同色的描边环——玻璃拟态/透明窗口下也能与图标分离；不使用数字角标（需求只说"小绿点"） |
| 出现条件 | `phase === "available"` 且 `version !== updateSkippedVersion` |
| 无障碍 | 按钮 `aria-label` / tooltip 文案：`有新版本 v{version}`（i18n 双语） |
| 点击行为 | 有绿点 → 直接打开对话框；无绿点 → 触发一次手动检查（按钮转圈），结果以 toast 反馈（已是最新 / 检查失败） |
| 对话框内容 | 版本号 + 标题 + release notes（`react-markdown` + GFM）+ 底部按钮：`前往 GitHub 下载`（`openUrl(releaseUrl)`）、`复制下载地址`、`跳过此版本`、`稍后` |
| 移除项 | 上一版 UI 里的 **Gitee 按钮**去掉（更新源仅 GitHub） |
| 安装完成提示 | 首启时比较 `lastRunVersion` 与当前版本，不同则 toast「已更新到 vX.Y.Z」+「查看更新日志」链接（覆盖"用户手动装完了"的闭环） |
| 设置页 | 「更新」分组：当前版本、自动检查更新（默认开）、已跳过版本 + 清除、手动检查按钮 |

### 3.3 安装器：强制 `\DocCraft` 子目录 + 免管理员

#### 3.3.1 配置

```jsonc
// src-tauri/tauri.conf.json
{
  "bundle": {
    "targets": ["nsis"],                     // 收敛为 NSIS（MSI 需要 VBSCRIPT 且对我们的路径逻辑无收益）
    "resources": { "resources/models": "models" },   // 见 §3.4：资源与 exe 同级
    "windows": {
      "webviewInstallMode": { "type": "downloadBootstrapper" },  // 默认；引导器按当前用户安装，不弹 UAC
      "nsis": {
        "installMode": "currentUser",        // ★ 免管理员：装到用户目录，注册表在 HKCU
        "installerHooks": "./windows/installer-hooks.nsh",
        "languages": ["English", "SimpChinese"]
      }
    }
  }
}
```

> `installMode` 只保留 `currentUser`：`perMachine` 需要提权，`both` 会让用户在安装页
> 选"所有用户"，与"免管理员"目标直接冲突。用户选定的**父目录**仍可自由指定（见 3.3.3）。

#### 3.3.2 钩子实现（`src-tauri/windows/installer-hooks.nsh`）

```nsis
!define DOCCRAFT_SUBDIR "DocCraft"

; 把 $INSTDIR 规范化为 <选定路径>\DocCraft；已是 …\DocCraft 时不再追加（幂等）。
Function DocCraftNormalizeInstDir
  StrCpy $R0 "$INSTDIR" -9                       ; 取尾部 9 个字符（"\DocCraft"）
  StrCmp $R0 "\${DOCCRAFT_SUBDIR}" done          ; 已带后缀 → 直接返回
  StrCpy $INSTDIR "$INSTDIR\${DOCCRAFT_SUBDIR}"
  done:
FunctionEnd

; 拒绝系统位置；写探针文件确认可写，不可写则中止安装并给出人话提示。
Function DocCraftAssertWritable
  ; 1) 系统位置拒绝（大小写不敏感的 StrCmp 由 ${StrStr} 完成，见 utils.nsh 的 ${StrStr}）
  ${StrStr} "$INSTDIR" "$PROGRAMFILES"    $R0
  ${If} $R0 != ""
    MessageBox MB_ICONSTOP "DocCraft 不能安装到 Program Files（该位置需要管理员权限）。请选择一个用户可写的目录。"
    SetErrorLevel 1
    Quit
  ${EndIf}
  ; …$WINDIR / $SYSDIR / $PROGRAMDATA 同法拒绝（略）
  ; 2) 可写性探测
  ClearErrors
  FileOpen $R1 "$INSTDIR\.doccraft-write-test" w
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "目标目录不可写：$INSTDIR。请选择其他目录。"
    SetErrorLevel 1
    Quit
  ${EndIf}
  FileWrite $R1 "ok"
  FileClose $R1
  Delete "$INSTDIR\.doccraft-write-test"
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  Call DocCraftNormalizeInstDir
  SetOutPath "$INSTDIR"        ; ★ 必须重设：File 指令按当前 SetOutPath 落盘
  Call DocCraftAssertWritable
!macroend
```

> 上面的代码是**设计示意**。实现见
> [`src-tauri/windows/installer-hooks.nsh`](../../src-tauri/windows/installer-hooks.nsh)：
> 全部内联在 `NSIS_HOOK_PREINSTALL` 宏里（不定义辅助函数，避免 NSIS 的栈式传参），
> 系统位置校验用"前缀 + 大小写不敏感 `StrCmp`"完成，提示文案为 **ASCII 英文**
> （NSIS 按安装程序代码页读取 `!include` 文件，含非 ASCII 文本需要带 BOM 的
> include 才能正常显示，属另一项独立改动）。

要点：

- **必须重新 `SetOutPath`**：模板在执行钩子前已经做过一次 `SetOutPath "$INSTDIR"`（旧值），
  不重设的话 `File` 仍会把文件拷到用户选的父目录里。
- **注册表/卸载器自动正确**：`MANUPRODUCTKEY`、`InstallLocation`、`UninstallString`
  都在钩子之后写入，记录的是最终路径，无需额外修补。
- **幂等**：升级/复装时 `RestorePreviousInstallLocation` 先把 `$INSTDIR` 恢复成注册表里的
  `…\DocCraft`，尾部比较会命中 `done` 分支，不会出现 `DocCraft\DocCraft`。
- 目录页返回的路径不带尾部反斜杠（仅盘根 `D:\` 例外，而盘根会被系统位置校验拒绝），
  因此规范化函数不需要额外的反斜杠裁剪逻辑。
- **不 fork 上游模板**：上述逻辑全部落在 hooks 里，避免长期维护一份 `installer.nsi` 副本。
  退路：若将来需要"在目录页上就即时纠正/回显最终路径"（钩子无法影响页面），
  再切换为 `nsis.template` 自定义模板（成本：跟随上游模板变更）。

#### 3.3.3 路径策略

| 用户选择 | 结果 |
|----------|------|
| 默认（不改） | `%LOCALAPPDATA%\DocCraft`（currentUser 默认值本身已带 `DocCraft`，幂等命中） |
| `D:\software` | `D:\software\DocCraft` |
| `D:\software\DocCraft` | 原样（不重复追加） |
| `D:\`（盘根） | 拦截 |
| `C:\Program Files\...` / `%WINDIR%` / `%ProgramData%` / `%ProgramFiles(x86)%` | 拦截（需提权，且违反免管理员目标） |
| `%USERPROFILE%` 直接（用户主目录本身） | **允许**——强制后缀后实际落点是 `<家目录>\DocCraft`，仍是独立目录，没有必要为难用户（实施时据此去掉了初版设计里的拦截） |

#### 3.3.4 "整个文件夹被删除"问题的准确描述

| 层次 | 事实 | 本方案的应对 |
|------|------|--------------|
| 历史 bug | 早期 NSIS 模板在"删除应用数据"勾选时执行 `RMDir /R /REBOOTOK "$INSTDIR"`，用户若把安装目录选成 `D:\software`，卸载会**连无关文件一起递归删除** | 上游 `1cf01f7` 已修（现模板为：逐文件 Delete → `RMDir /REBOOTOK` 仅针对 `resources_ancestors`（我们自己的资源目录）→ `RMDir "$INSTDIR"` 非递归）。我们锁定较新的 Tauri 2，风险已大幅下降 |
| 残余风险 | ① 任何针对 `$INSTDIR` 的删除行为，若安装根是用户自选的大目录，影响面不可控；② `resources_ancestors` 的递归删除作用于"资源的祖先目录"，用户把自己的文件放进同一个资源目录时会被波及；③ 旧版本安装器（用户机器上残留的 `uninstall.exe`）仍按旧逻辑工作 | ① 强制 `\DocCraft` 子目录 → 影响面收敛到专属目录（**这是需求 4 的核心价值**）；② §3.4 扁平化后，资源与数据边界清晰：`models\` 由安装器管理、`data\` 与 `models\layout\` 是用户可写区（升级前后由迁移逻辑保证不丢）；③ 迁移指引里提示"若曾用旧安装器装在非专属目录，先手动卸载再装新版" |
| 参数注意 | 静默升级应带 `/UPDATE`（跳过卸载流程、保留快捷方式与注册表），而不是裸 `/S` | 文档给出手动升级命令：`DocCraft_x.y.z_x64-setup.exe /S /UPDATE` |

### 3.4 资源布局扁平化（取消 `doccraft_resources` 层）

#### 3.4.1 目标布局

```
<选定路径>\DocCraft\                 ← $INSTDIR（§3.3 强制）
├─ DocCraft.exe                      ← 与下面这些"目录"同级
├─ uninstall.exe
├─ models\                           ← 原 doccraft_resources\models
│  ├─ PP-OCRv6_*.mnn                 ← **安装包不带**，由用户后续安装（在线下载 / 拖放）
│  ├─ ppocr_keys_v6_*.txt
│  └─ layout\<模型名>\{*.mnn,layout-meta.json}   ← 用户手动下载的版面模型落这里
└─ data\                             ← 原 doccraft_resources\data（运行时生成）
   ├─ ocr-config.json                ← OCR 厂商 + DPAPI 密文密钥
   ├─ app-settings.json
   └─ usage-YYYY-MM.jsonl            ← 用量日志
```

`<exe_dir>/screenshots` 维持不变（在 `app_data_dir()` 下）。

> **模型不进安装包**（2026-09-28 决定）：`bundle.resources` 整块移除，安装包只带程序本体。
> 模型改由用户后续获取——在线安装（尚未实现）或直接把模型文件/目录拖进
> `<安装目录>\models\`（尚未实现）。本期只保证**路径约定稳定**：
> `models/` 与 `models/layout/` 是唯一的模型查找位置，`core::models_dir()` 是唯一入口，
> 将来加安装 UI 时不需要再动运行时代码。
> 代价：安装后 `models/` 不存在，本地 OCR 会提示
> `OCR model directory not found. Please place models at: <安装目录>\models`
> ——正好是用户接下来要放模型的位置，属预期状态。
> dev 侧不受影响：`build.rs::sync_resources()` 仍把 `resources/models` 镜像到
> `<target>/<profile>/models`，开发机照常跑本地 OCR。

#### 3.4.2 打包侧：**不随包模型**

```jsonc
"bundle": {
  "targets": ["nsis"],
  "windows": { "nsis": { "installMode": "currentUser", "installerHooks": "./windows/installer-hooks.nsh" } }
  // 没有 "resources" —— 模型不进安装包
}
```

安装包只带程序本体（实测 **6.0MB**，2026-09-28；含应用本体与运行时资源，不含模型）。模型是纯数据，交由用户按需获取，
这样也免掉"每个档位都塞进安装包"的体积/更新代价。

> **历史教训（保留备查）**：实现过程中一度把模型接进 `bundle.resources`。
> 注意 `bundle.resources` 是**按磁盘目录**展开的，`src-tauri/.gitignore` 只影响
> 干净检出、管不住本机已存在的文件——当时用目录映射 `"resources/models": "models"`，
> 本机（`resources/` 里有 209MB 模型）打出的安装包是 **173MB**，把 `.gitignore`
> 排除掉的 medium 档（67MB）与 `PP-DocLayoutV3.mnn`（125MB）一起打了进去，
> 而 CI 的干净检出只有 ~19MB，**本地与 CI 产物不一致**（很难发现的一类问题）。
> 改成 7 个文件的显式清单后是 21MB。**如果将来要恢复随包，务必用显式文件清单，
> 不要用目录映射**；并且在 CI 里核对安装包体积。

- **模型获取方式**：已由
  [00022_model-download.md](./00022_model-download.md) 落地 —— ① 设置页「模型」分组
  在线下载（ModelScope，逐文件校验 size + SHA-256）；② 拖放/选择本地文件导入。
  两者都只调用 `core::models_dir()`，与打包、签名解耦。
  （本期预留的"设置页版面模型缺失提示 + ModelScope 外链"在 00022 里已删除，
  下载入口统一到「模型」分组。）
- medium 档（det+rec 67MB）与 `PP-DocLayoutV3.mnn`（125MB）本来就被
  `src-tauri/.gitignore` 排除、不入库；现在**任何档位都不随包**，在设置页「模型」分组
  下载后落到 `<安装目录>\models\`（OCR 档）或
  `<安装目录>\models\layout\PP-DocLayoutV3\`（版面模型）。
- `build.rs::sync_resources()` 的镜像目标从 `<target>/<profile>/doccraft_resources/`
  改为 `<target>/<profile>/models`（dev 运行时的目录结构与安装后一致，避免两套路径假设）。
  dev 仍然镜像整个 `resources/models`（含本机存在的 medium / 版面模型），这是开发便利，
  与"安装包不带模型"不冲突。

#### 3.4.3 代码改动点

| 文件 | 改动 |
|------|------|
| `src-tauri/src/core/mod.rs` | `get_resources_dir()` → 返回 **exe 所在目录**；建议重命名为 `install_dir()`，并新增 `models_dir()` / `data_dir()` 两个语义化函数（`get_resources_dir` 保留为 `install_dir` 的别名，减少一次性改动面） |
| `src-tauri/src/core/settings.rs` | `data_dir()` = `<exe_dir>/data`；新增首次运行迁移（见 3.4.4） |
| `src-tauri/src/core/usage_stats.rs` | 无需改动（路径来自 `settings::data_dir`） |
| `src-tauri/src/core/ocr.rs` | `ocr_resource_dir()` = `<exe_dir>/models`（只改基路径） |
| `src-tauri/src/core/layout.rs` | `layout_models_dir()` = `<exe_dir>/models/layout`（只改基路径） |
| `src-tauri/build.rs` | 镜像目标改为 `<target>/<profile>/` 根目录，`doccraft_resources` 一层去掉 |
| `README.md` / `README_ZH.md` | 手动放置版面模型的路径改为 `<安装目录>\models\layout\...` |
| `docs/index.md` | 布局分析提示文案与 Project Structure 一节同步 |

#### 3.4.4 一次性迁移（"把原有的同步过来"）

放在应用侧而不是安装器钩子里，理由：

| 放到安装器（NSIS hook） | 放到应用侧（推荐） |
|-------------------------|--------------------|
| 需要在 NSIS 里手写递归复制（`FindFirst/FindNext`），代码冗长难测 | Rust 侧几行 `fs` 递归即可，可写单测 |
| 只有一份上下文（注册表旧路径），拿不到用户/权限失败等细节 | 能枚举多个候选位置、能记日志、失败能降级提示 |
| 升级路径一旦变化（用户换目录、换便携版）逻辑易漏 | 每次启动都可幂等重试，不依赖安装器版本 |

迁移规则（`core/migrate.rs::migrate_once`，在 `setup()` 中、读取设置**之前**执行）：

| 顺序 | 候选旧位置 | 动作 |
|------|-----------|------|
| 1 | `<install_dir>/doccraft_resources/models/**` | 合并到 `<install_dir>/models/`（用户自己下的模型、旧版带的档位，一个都不丢） |
| 2 | `<install_dir>/doccraft_resources/data/**` | 复制到 `<install_dir>/data/`（仅复制目标不存在的文件，不覆盖） |
| 3 | 源目录不存在 | 直接返回 0（零开销） |

约束：

- **只补不删**：源目录保留（用户可自行清理），目标已有的同名文件**不覆盖**（安装包自带的
  `models/` 可能更新，用户自己下的 `layout/` 优先保留）。
- **DPAPI 密文可直接复用**：密钥与当前 Windows 用户绑定，同一用户下换目录仍能解密
  （换机器/换用户则不可，属预期）。
- 迁移失败只 `eprintln!`（打印复制数量），不阻塞启动。
- 幂等：目标已存在同名文件即跳过，所以每次启动重复执行也安全（`OnceLock` 之外的
  重复调用只是几次 `read_dir`）。

> **实现范围说明**：初版设计还打算读注册表里的旧安装目录（`InstallLocation`），
> 用于"用户换了安装目录"的场景；实现时**未做**——跨目录的旧数据需要读注册表
> （要加 `windows-sys` 的 `Win32_System_Registry` feature）且收益有限，
> 已作为已知限制记入 §五 风险表。

## 四、实施计划

### 阶段 1：检查链路迁移到 Rust（不影响 UI 结构）

1. `core/update.rs`：抽出 `UpdateSnapshot` + `UpdateState`（托管状态）；
   保留现有 HTTP 检查逻辑与 `is_newer()`，新增 `check(app, force)` 与 `emit_state()`。
2. `lib.rs`：`manage(UpdateState)`；`setup()` 内 `std::thread::spawn` → `sleep 3s` →
   `block_on(update::startup_check)`；注册 `get_update_state` / `skip_update_version` /
   `clear_skipped_version`，并改造 `check_for_update` 签名。
3. `core/settings.rs`：`autoCheckUpdate`（默认 `true`）、`updateSkippedVersion`（默认 `""`）、
   `lastRunVersion`（默认 `""`，首启提示用）。

### 阶段 2：前端绿点 + 对话框

4. `src/lib/types.ts` / `ipc.ts`：`UpdateSnapshot` + 4 个命令 + `listenUpdateState`。
5. `src/components/header-actions.tsx`：删 `cachedCheck` 与 mount 期请求；订阅事件；
   绿点；对话框按钮改为「前往 GitHub 下载」/「复制下载地址」/「跳过此版本」；移除 Gitee。
6. `src/views/settings.tsx` + `src/i18n/translations.ts`：更新分组与双语词条。
7. `src/App.tsx`：首启「已更新到 vX.Y.Z」提示（`lastRunVersion` ↔ 当前版本）。

### 阶段 3：资源布局扁平化

8. `core/mod.rs` / `settings.rs` / `ocr.rs` / `layout.rs`：基路径改为 exe 目录。
9. `core/migrate.rs`：旧 `doccraft_resources` → 新位置的幂等迁移（含单测：无旧目录、
   有旧目录、目标已存在文件、DPAPI 配置文件）。
10. `build.rs`：dev 镜像目标改为 `<target>/<profile>/models`。
11. `tauri.conf.json`：**不加 `bundle.resources`**（模型不进安装包）；
    NSIS `installMode` / `installerHooks` / 语言。

### 阶段 4：安装器

12. `src-tauri/windows/installer-hooks.nsh`：`$INSTDIR` 规范化 + 可写性/系统位置校验。
13. `tauri.conf.json`：`nsis.installMode = "currentUser"`、`installerHooks`、语言、
    `targets` 收敛为 `["nsis"]`。
14. 实测：`pnpm tauri build` → 在干净环境（无管理员）安装到 `D:\test`，
    确认最终落在 `D:\test\DocCraft`，且 `D:\test` 下无散落文件；卸载后 `D:\test` 仍在。

### 阶段 5：文档与收尾

15. `README.md` / `README_ZH.md` 手动装模型的路径、`docs/index.md`（Features 的
    Update check 条目 + Project Structure + Design docs 编号）、
    `docs/changelog/changelog-v0.3.0.md`。

## 五、风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| `data/` 放安装目录 | 卸载勾选"删除应用数据"会连 `ocr-config.json`（含密钥）一起删；同机多用户共享同一份配置；安装目录被手动清空则设置丢失 | 本期按需求实现；文档明确告知；可选后续增强：`data/` 迁到 `%APPDATA%\<identifier>`（`migrate` 逻辑已具备搬移能力，届时只需换目标路径） |
| 老用户曾装进非专属目录（旧安装器） | 其残留 `uninstall.exe` 仍按旧逻辑工作；升级后新旧两份并存 | 发布说明给出升级指引（先卸载旧版再装新版）；首启检测到"同一目录下存在非 `DocCraft` 的旧安装"时提示（可选） |
| 用户把手动下载的模型放在旧路径 | 升级后扫描不到 | §3.4.4 迁移覆盖 `<install_dir>/doccraft_resources/models/**`；设置页的"模型缺失"提示文案同步更新到新路径 |
| **换了安装目录**时的旧数据不会自动找到 | 旧目录里的 `data/`（含密钥）与用户模型留在原地 | 已知限制（见 §3.4.4 实现范围说明）：本期只处理"同一目录内的旧布局"。文档中提示用户可手动把旧目录的 `models/`、`data/` 拷到新安装目录；后续如需自动，读注册表 `InstallLocation` 即可扩展 |
| 迁移与安装器写入竞争 | 极端情况下文件被占用 | 复制失败仅记录并跳过（不覆盖、不删除），下次启动重试 |
| 用户选到不可写位置 | 安装到一半失败 | §3.3.2 安装前探针 + 明确文案拦截 |
| NSIS 钩子与上游模板行为漂移 | 升级 Tauri 后钩子失效（例如插入点变化） | 钩子只依赖两个不变量（钩子在 `SetOutPath` 之后、注册表写入在其后）；`cargo tauri` 升级后跑 §6 的安装器验收项；必要时切自定义模板 |
| 安装包不带模型 | 装完本地 OCR 不可用（首次调用提示 `OCR model directory not found. Please place models at: <安装目录>\models`） | 预期状态：模型由用户后续在线安装/拖放（本期不做）。dev 侧由 `build.rs` 镜像保证开发可用；设置页的模型缺失提示已指引下载地址 |
| 将来恢复随包时误用目录映射 | 安装包体积暴涨且本地与 CI 不一致 | §3.4.2 的历史教训：必须用显式文件清单，并在 CI 核对体积 |
| 移除 Gitee 入口 | 部分网络下访问 GitHub 困难 | 保持"复制下载地址"按钮；文档说明可用系统代理（不做镜像，符合需求约束） |
| 移除 Gitee 入口 | 部分网络下访问 GitHub 困难 | 保持"复制下载地址"按钮；文档说明可用系统代理（不做镜像，符合需求约束） |

## 六、验收清单

- [ ] 启动后 ~3s 内完成一次检查；断网 / 10s 超时时应用完全正常，无 toast、无卡顿。
- [ ] 前端渲染路径上没有任何更新检查请求（DevTools Network 中主窗口加载阶段无 github 请求）。
- [ ] 有新版本时顶栏按钮右上角出现小绿点；点击直接打开对话框；对话框按钮跳
      `https://github.com/tansen87/DocCraft/releases/latest`；**不存在 Gitee 按钮**。
- [ ] 点「跳过此版本」→ 绿点消失；设置页清除后可再次提示。
- [ ] 设置页关闭"自动检查更新"→ 启动不再发起检查，手动按钮仍可用。
- [ ] 手动安装新版本后首启出现「已更新到 vX.Y.Z」提示。
- [ ] **安装路径**：选 `D:\test` → 程序落在 `D:\test\DocCraft`，`D:\test` 下无散落文件；
      选 `D:\test\DocCraft`（重复安装）→ 不出现 `DocCraft\DocCraft`。
- [ ] 选 `C:\Program Files\DocCraft` → 安装前被拦截并给出人话提示，全程无 UAC 弹窗。
- [ ] 安装/卸载全程不需要管理员权限；卸载后 `D:\test` 目录仍存在且其余文件完好。
- [ ] **资源与数据布局**：安装后 `<安装目录>` 下只有 `DocCraft.exe` 与 `uninstall.exe`
      （**不带模型**、没有 `doccraft_resources` 这一层）；`data\` 在首次写入设置后出现。
- [ ] **不带模型**：全新安装后本地 OCR 提示 `OCR model directory not found ... <安装目录>\models`
      （即预期的"待用户放模型"状态），其它功能（PDF 文本提取、Markdown→Excel、远程 AI OCR）正常。
- [ ] **迁移**：准备一份 0.2.x 布局（`doccraft_resources\data\{ocr-config.json,app-settings.json}` +
      `doccraft_resources\models\layout\<自下模型>`）→ 首次启动后内容出现在
      `<安装目录>\data\` 与 `<安装目录>\models\layout\`，且配置（含密钥）可用、原目录保留。
- [ ] 迁移幂等：连续启动 3 次不产生重复文件、不覆盖用户已改的配置。
- [ ] `models\layout\` 下用户手动放入的模型能被 `list_layout_models` 识别并可选。
- [ ] 打包体积：`pnpm tauri build` 产出的 NSIS 安装包约 **6.0MB**（实测，2026-09-28，不含模型）。
- [ ] `pnpm exec tsc --noEmit`、`cargo check`、`cargo test --lib` 全绿。

## 七、实施记录（2026-09-28）

与设计稿的三处偏差：

| # | 设计稿 | 实现 | 原因 |
|---|--------|------|------|
| 1 | 钩子用 `${StrStr}` + 辅助函数做校验，中文提示文案 | 全部内联进 `NSIS_HOOK_PREINSTALL` 宏，用"前缀 + 大小写不敏感 `StrCmp`"校验，提示为 ASCII 英文 | NSIS 的栈式传参易错且无法在本机编译验证；`!include` 的非 ASCII 文本需要 BOM 才能正确显示，属独立改动 |
| 2 | 首启"已更新到 vX"由后端在 `setup()` 里 emit 事件 | 改为前端主动拉取 `take_version_notice()`（一次性消费） | `setup()` 早于前端监听器注册，事件会丢；拉取式无竞态 |
| 3 | §3.3.3 拦截 `%USERPROFILE%` | 放行 | 强制 `\DocCraft` 后缀后落点是 `<家目录>\DocCraft`，本身已是独立目录，拦截只会为难用户 |

落地文件清单（便于 review）：

| 文件 | 内容 |
|------|------|
| `src-tauri/src/core/update.rs` | 重写：`UpdateSnapshot` / `UpdateState` / `VersionNoticeState`、`startup_check`、`check`、`skip_version`、`clear_skipped_version`、`record_run_version`、`take_version_notice`、`is_newer`（含单测） |
| `src-tauri/src/core/migrate.rs` | 新增：`migrate_once` / `copy_missing`（含 2 个单测：缺源空跑、嵌套复制且不覆盖） |
| `src-tauri/src/core/mod.rs` | 新增 `install_dir()` / `models_dir()` / `data_dir()`；移除 `get_resources_dir()` |
| `src-tauri/src/core/settings.rs` | `data_dir()` → `<install_dir>/data` |
| `src-tauri/src/core/ocr.rs`、`core/layout.rs` | 模型目录改走 `core::models_dir()` |
| `src-tauri/src/models.rs` | `AppSettings` 增加 `autoCheckUpdate` / `updateSkippedVersion` / `lastRunVersion` |
| `src-tauri/src/lib.rs` | `migrate_once()`、`record_run_version()`、延迟 3s 的启动检查线程、5 个命令、2 个托管状态 |
| `src-tauri/build.rs` | dev 镜像目标 → `<target>/<profile>/models`（与安装布局一致） |
| `src-tauri/tauri.conf.json` | **不配 `bundle.resources`**（模型不进安装包，安装包 ~6.0MB）、`targets: ["nsis"]`、NSIS `installMode: currentUser` + `installerHooks` + 中英语言 |
| `src-tauri/windows/installer-hooks.nsh` | `$INSTDIR` 幂等追加 `\DocCraft`、重新 `SetOutPath`、系统位置拦截、写探针校验 |
| `src/lib/types.ts`、`src/lib/ipc.ts` | `UpdateSnapshot` / `VersionNotice`、5 个命令、`onUpdateState` 订阅 |
| `src/components/header-actions.tsx` | 事件驱动 + 右上角绿点 + 手动下载对话框（移除 Gitee、移除旧角标） |
| `src/views/settings.tsx` | 新增「更新」分组（当前版本 / 立即检查 / 启动检查开关 / 已跳过版本） |
| `src/App.tsx` | 首启"已更新到 vX.Y.Z"提示（带"查看 GitHub"动作） |
| `src/i18n/translations.ts` | 新增 `update.*` 与 `settings.update` 词条；修正模型放置路径文案 |
| `README.md`、`README_ZH.md`、`docs/index.md` | 资源/配置路径、安装器与更新行为同步 |

## 八、参考

- 上游 NSIS 模板（`MUI_PAGE_DIRECTORY`、`$INSTDIR` 占位符逻辑、
  `RestorePreviousInstallLocation`、`NSIS_HOOK_PREINSTALL` 插入点、卸载删除范围）：
  `crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi`
  （本项目依赖的 Tauri 2 版本随依赖锁定）
- 修复"卸载删除整个安装目录"的提交：`tauri-apps/tauri@1cf01f7`
  （`fix(bundler/nsis): Don't use /R flag on installation dir`）
- Tauri 文档 · Windows Installer（`installMode` 默认 currentUser 免管理员、
  `installerHooks`、WebView2 安装模式）：<https://v2.tauri.app/distribute/windows-installer/>
- Tauri 文档 · 打包资源 `bundle.resources` 映射（资源相对 `$INSTDIR` 落盘）：
  <https://v2.tauri.app/develop/resources/>
- 本项目现状：`src-tauri/src/core/update.rs`、`src-tauri/src/core/mod.rs`（`get_resources_dir`）、
  `src-tauri/src/core/settings.rs`（`data_dir`）、`src-tauri/build.rs`（`sync_resources`）、
  `src/components/header-actions.tsx`
- 相关设计文档：[00016_local-ocr-layout-analysis.md](./00016_local-ocr-layout-analysis.md)
  （版面模型目录发现与手动下载提示）
