# DocCraft Changelog

All notable changes to DocCraft are documented in this folder. The format is
based on [Keep a Changelog](https://keepachangelog.com/), and this project
adheres to [Semantic Versioning](https://semver.org/).

DocCraft is a cross-platform **PDF → Markdown** and **Markdown → Excel**
desktop converter built with Tauri 2, React, TypeScript and
[`pdf-inspector`](https://crates.io/crates/pdf-inspector).

---

## [0.2.0] - 2026-08-30

This release builds on the v0.1.0 foundation with a broad **glassmorphism UI
overhaul**, a lighter **OCR model tier**, richer **draw-table** and
**PDF → Markdown** controls, a dedicated **snip result window**, local **usage
statistics**, and a more useful **update-check** dialog.

### Added

- **Snip result window** — a standalone glassmorphism result window with
  rounded corners, a draggable header (green hover overlay), pin-on-top,
  copy-to-clipboard, and close buttons (all with tooltips), positioned at the
  bottom-right of the primary monitor. Adds backend settings `snipResultPopup` /
  `snipAutoCopy` / `snipResultOpacity` with real-time opacity updates, a bundled
  tray icon (left-click triggers a screenshot capture), and the required
  capabilities/permissions (`4f1a3bb`).
- **Tiny OCR model tier & Image-to-MD views** — a new `OcrModelSize::Tiny`
  variant (PP-OCRv6_tiny models), the default model changed from medium to
  small, the `cacheOcrEngine` toggle removed (the engine is always cached now),
  and new image-to-md components under `src/components/img2md/`
  (`226ce84`).
- **Draw-table: high-precision extraction mode** for scanned pages
  (`af0f8a7`).
- **Draw-table: horizontal row lines** in PDF & image table extraction, with
  grid-row bucketing and long-filename list-overflow fixes (`8b0bf0c`).
- **Draw-table: tri-state tool** — a unified draw / vertical / horizontal /
  exclude mode UX (`a8ce201`).
- **Custom AI vision prompts** — configurable custom prompts for the AI OCR
  vision provider in settings (`9073992`).
- **PDF → Markdown page range** — convert a selected range of pages from a PDF
  (`1a5965f`).
- **PDF → Markdown page-link mode** — insert page links into the converted
  Markdown (`107b71b`).
- **Local usage statistics** — a usage-statistics card showing PDF / image
  split counts with a clear button (`ddc1c83`).
- **PDF region exclusion** — exclude user-selected regions from conversion and
  thread the text-separator setting through extraction (`0ed6a0a`).
- **Glassmorphism UI & glass-opacity sync** — a custom transparent title bar
  with `WindowControls` and a drag region, semantic status-color tokens, a
  unified `GlassPanel`, a `GlassOpacityContext` that syncs opacity across the
  main window and panels with live preview, a bundled tray icon (left-click
  triggers capture), and the glass visual language applied across the existing
  stack (`12811d3`, `e4fc85a`, `586f521`).
- **Update check: Gitee link & always-openable release page** — the update
  dialog now offers both GitHub and Gitee release links and stays openable even
  when already on the latest version; tooltips added to the language and theme
  toggle buttons (`39dc190`).

### Changed

- **Settings UI refinement** — improved EN/ZH i18n strings for opacity/window
  settings, removed the hotkey clear button, and made the usage-stats grid
  responsive (`7664c45`).
- **MD → Excel preview** — stream Markdown content to the preview and remove
  the separate table-preview pane (`d49f811`).
- **Screenshot snip latency** — cut OCR latency for screenshots and remember
  the result-window position (`702f51c`).
- **UI re-render performance** — memoize the tab views and the PDF page grid to
  skip redundant workspace re-renders on theme/language switches (`cbb6358`).

### Fixed

- **PDF → Markdown exclusion** — rebuild excluded table pages as GFM tables and
  add a collapse/expand control to the exclusion panel (`184bfce`).
- **Settings layout** — keep row controls pinned to the right edge (`f42785f`).
- **Settings hotkey hint** — simplify the hotkey-recording hint (`fcce47b`).

### Docs

- Add the v0.1.0 changelog and update `docs/index.md`, `README.md`,
  `README_ZH.md` (`4d2e3a7`, `b784bcb`, `a131db8`); add the glass-opacity-sync
  design note `docs/design/00008_glass-opacity-sync.md` (`e4fc85a`).

---

_Commit range: `df32360` (v0.1.0 boundary, exclusive) → `39dc190` (HEAD).
24 commits (excludes merges)._

_Release-prep version bump to `0.2.0` in `package.json`, `src-tauri/Cargo.toml`,
`src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json` is currently uncommitted
working changes._
