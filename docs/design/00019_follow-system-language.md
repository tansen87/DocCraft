# 00019 - 语言设置支持"跟随系统"

- 状态: 待评审
- 日期: 2026-09-13
- 关联文档: [../index.md](../index.md)(i18n 现状)

## 1. 背景与问题

语言切换(`LanguageToggle`)目前是 English / 中文 二选一,首次启动固定英文,
中文系统用户必须手动切换一次。主题已有"跟随系统"(`theme.system`)先例,
语言补齐同样的选项:默认跟随系统语言,同时保留手动固定。

### 1.1 现状核对

- `src/i18n/translations.ts:1` — `export type Lang = "en" | "zh"`;
- `src/i18n/index.tsx:12` — 存储 key `doccraft-language`,`loadLang()` 只认
  `"en"` / `"zh"`,无存储或非法值回退 `DEFAULT_LANG = "en"`;
  context 只暴露解析后的 `lang`;
- `src/components/language-toggle.tsx:18` — 下拉两项,勾选标记比较 `lang`;
- `setLang` / `lang` 的消费方仅 language-toggle 与 i18n 模块自身,
  扩展 context 无其他影响面。

### 1.2 目标

- 新增"跟随系统"偏好并作为**新用户默认**:中文系统首启即中文;
- 手动选择的持久化行为与现状一致;存量用户升级后语言不变;
- 零新依赖、零后端改动。

## 2. 方案设计

### 2.1 偏好模型

存储值从 `Lang` 扩展为 `LangPreference = "system" | "en" | "zh"`,
仍存 `doccraft-language`(无其他引用点,无迁移成本):

- 有存储且合法 → 尊重(显式语言或"跟随系统");
- 无存储(新用户)→ `"system"`;
- 非法值(如手改为 `"fr"`)→ 按 `"system"` 处理。

渲染语言仍为 `Lang`:`resolveLang(pref)` 在 `pref === "system"` 时取
`navigator.language` 小写前缀 `zh` → `"zh"`,否则 `"en"`。WebView 内
`navigator.language` 即系统 locale,不引入 `@tauri-apps/plugin-os`;
不监听系统语言热切换,重启应用生效。

### 2.2 Provider 变更

`LanguageProvider` 同时持有 `preference`(用户偏好)与 `lang`
(解析后的渲染语言):`setLang(next: LangPreference)` 写存储并同步两者;
`t()` 与既有消费方继续只读 `lang`,context 新增只读 `preference`
供下拉勾选。

### 2.3 语言菜单

`language-toggle.tsx` 改为三项:**跟随系统**(新增字典 key
`language.system`,en `System` / zh `跟随系统`,与 `theme.system`
用词一致,置于首位)/ English / 中文;勾选标记按 `preference` 比较。
语言切换保持在 header 下拉,设置页不新增分区。

### 2.4 改动范围

| 文件 | 改动 |
| --- | --- |
| `src/i18n/translations.ts` | 导出 `LangPreference`;en/zh 新增 `language.system` |
| `src/i18n/index.tsx` | `loadPreference` / `resolveLang`;Provider 持有 `preference` + `lang` |
| `src/components/language-toggle.tsx` | 菜单加"跟随系统"项,勾选按 `preference` |
| `docs/index.md` | i18n 段落同步(三态切换、默认跟随系统) |

## 3. 验收清单

1. 清空存储后启动:中文系统 → 中文 UI;英文及其他语言系统 → 英文 UI;
2. 存量用户(已存 `en` / `zh`)升级后语言不变;
3. 手动选 English / 中文 重启后保持;切回"跟随系统"恢复按系统解析;
4. 下拉勾选标记跟随 `preference`;非法存储值按"跟随系统"处理;
5. `pnpm exec tsc --noEmit` 通过。
