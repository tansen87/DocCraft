# DocCraft Changelog

All notable changes to DocCraft are documented in this folder. The format is
based on [Keep a Changelog](https://keepachangelog.com/), and this project
adheres to [Semantic Versioning](https://semver.org/).

DocCraft is a cross-platform **PDF → Markdown** and **Markdown → Excel**
desktop converter built with Tauri 2, React, TypeScript and
[`pdf-inspector`](https://crates.io/crates/pdf-inspector).

---

## [0.3.4] - 2026-10-26

v0.3.2 stopped the Windows installer from adding an extra `DocCraft` folder to
the install path, but installs created by an older build stayed buried in
`<chosen>\DocCraft\DocCraft` and kept updating there. This release folds those
installations back into a single folder - settings and models included - and
makes the path check itself robust for short and trailing-separator paths.

### Fixed

- **Already-nested installs are folded back one level** - the NSIS pre-install
  hook now recognises a `<chosen>\DocCraft\DocCraft` install (and longer
  chains), renames the inner `data/` (settings and the DPAPI-encrypted keys) and
  `models/` up to the outer folder, switches `$INSTDIR` there and lets the
  installer record the outer path in the registry. The post-install hook then
  repoints the existing desktop / start-menu shortcuts (`/UPDATE` never
  recreates them) and deletes the leftover folders, so every later update lands
  in one folder. When a move fails (app still running, permissions) the fold is
  abandoned and the update continues in place - a nested path is harmless,
  losing the settings is not.
- **The install-path suffix check no longer misses short paths** - normalising
  `$INSTDIR` compared a fixed nine-character slice, so a path like `C:\DocCraft`
  was read as ending in `:\DocCraft` and got a second `\DocCraft` appended. The
  check now inspects the last path component and its separator separately, and
  trailing `\` characters are trimmed before comparing, so the installer never
  adds a second level whatever shape the restored path has.
