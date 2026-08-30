# DocCraft Changelog

All notable changes to DocCraft are documented in this folder. The format is
based on [Keep a Changelog](https://keepachangelog.com/), and this project
adheres to [Semantic Versioning](https://semver.org/).

DocCraft is a cross-platform **PDF → Markdown** and **Markdown → Excel**
desktop converter built with Tauri 2, React, TypeScript and
[`pdf-inspector`](https://crates.io/crates/pdf-inspector).

---

## [0.1.0] - 2026-08-23

This is the first release of DocCraft. It establishes the core conversion
engine, the three main workspaces (PDF → Markdown, Image → Markdown,
Markdown → Excel), the on-device/local + remote OCR pipeline, and the
settings/configuration infrastructure.

### Added

- **Project foundation** — initial repository, `.gitignore`, and `LICENSE`
  (`474ef1f`, `7d2aa93`, `626a209`).
- **Draw-table extraction (PDF & Image)** — line-drawing table extraction for
  unsegmented PDFs with an SVG overlay on the pdfjs preview; multi-page support
  (up to 5 pages) with per-page line state, dark-mode compatibility, and an
  "extract first 5 pages" preview button (`c5d71d4`, `dfd5297`, `5bcd5bf`).
- **Local PaddleOCR engine** — on-device OCR via the `ocr-rs` crate with
  reading-order text sorting, an `OcrEngineCache`, and a `local_ocr_enabled`
  setting; routes OCR requests to the local engine when enabled
  (`cef971b`, `554c9f4`).
- **Unified OCR mode** — a single selector with five options
  (`ForceLocal` / `ForceAi` / `NonTextLocal` / `NonTextAi` / `Disabled`)
  replacing the previous flag-based controls (`f26ca8c`).
- **Local PaddleOCR fallback for draw-table** — scanned / image-only pages are
  rendered to PNG and recognized on-device, mapped back into PDF point space
  and cut by drawn column boundaries (`8a047a4`).
- **AI vision fallback for draw-table** — pages without a text layer are routed
  to the configured remote vision provider in `ForceAi` / `NonTextAi` modes,
  with drawn separator positions sent as prompt hints (`7283f41`).
- **Image → Markdown workspace** — a new tab accepting PNG / JPEG via drag &
  drop or file picker, with a deduplicated thumbnail list, OCR-backed
  conversion (local PaddleOCR or remote AI vision), per-image preview, and
  merged / per-image / one-by-one export (`0dfb385`, `b8c91c8`, `d4d2f31`).
- **Draw-table overlay for images** — vertical-line drawing on imported images
  with local / AI OCR support (`b8c91c8`).
- **Screenshot snip feature** — a transparent multi-monitor overlay to capture
  a selection, recognize it through the OCR pipeline, with a hotkey recorder
  in settings (`33767e4`, `54b0c94`).
- **System tray** — open / screenshot / exit menu, left-click to show the main
  window, and close-to-tray behavior with an `enable_tray` setting
  (`d2d0e18`).
- **Configurable text separator** — a setting (pipe / space / comma / tab /
  caret) controlling how OCR blocks within a line are joined, plus a shared
  `formatDuration` helper (`d0a12dc`).
- **i18n (EN / ZH)** — a typed `en`/`zh` translation dictionary with a runtime
  language toggle persisted to `localStorage`, replacing all hard-coded UI
  strings (`ab96085`); Chinese README added (`1aa62eb`).
- **Status bar activity center** — structured, severity-colored notices with an
  unread badge, clear-all, retry action, interactive page chips, and a live
  progress indicator (`3682a34`, `2d173c6`).
- **Graceful OCR fallback** — when no usable OCR provider is configured, hybrid
  conversion completes instead of failing; OCR pages are skipped and recorded
  with `<!-- OCR 跳过 … -->` comments (`2d173c6`).
- **Source-page labels for Excel** — converted pages are delimited by
  `<!-- Page N -->` markers and Excel tables are tagged with their source page
  (`2ff165f`).
- **Export-in-progress animations** — spinners and disabled states on Markdown
  and Excel export buttons (preview, per-item, and "Export All")
  (`0bcf6cd`).
- **Global task indicator & batch control** — a header pill per active task
  (PDF / Image / MD→Excel) with progress, individual and bulk cancellation of
  PDF batch conversions, and an "Open folder" action on export success toasts
  (`581b978`).
- **Settings rework** — scrollable waterfall layout, the "only tables to
  Excel" option, and a modernized grouped panel layout (`23ee046`, `fc1ffdd`,
  `048615d`).
- **Configuration backup / restore and release update check** — the headline
  feature of this release: back up and restore app settings, and check for new
  releases (`df32360`).

### Changed

- **English page markers & faster large-doc rendering** — emit
  `<!-- Page N -->` markers (legacy Chinese markers still parsed for older
  files), cache the parsed pdfjs document in the draw-table panel, and
  paginate / lazily render the Markdown preview via `IntersectionObserver`
  (`596f8b1`).
- **Line-draw table extraction speed-up** — extract text only for processed
  pages and drop the redundant `lopdf` re-parse (`f92eacc`).
- **Screenshot pipeline optimizations** — JPEG preview encoding, fast PNG crop
  encoding, per-monitor overlay reuse, magnifier / coordinate / color-picker
  tool palette, and `xcap`-based fast single-monitor capture
  (`54b0c94`, `14d9485`).
- **UI language & icon** — app icon refinement (`47eface`).
- **Settings save unification** and **real OCR-needs reporting / shared
  extraction** across conversions (`1b4613d`, `f8ca352`).

### Fixed

- **UI responsiveness** — run heavy Tauri commands off the main thread to stop
  UI freezes (`b11b451`).
- **Large previews** — keep extracted-table and Raw previews responsive and
  paginated, reserving real heights when reclaiming pages
  (`122ac34`, `e604685`).
- **Backend robustness** — remove panicking `unwrap`s and localize backend
  messages to English (`7af7e18`).
- **OCR pipeline issues** surfaced during image-page conversion testing
  (`1b4613d`).
- **Drag-drop error spam** — only show drag-drop error toasts for the active,
  visible tab; remove file-type validation errors from the drop hook
  (`d0a12dc`).
- **Draw-table result display** — show the real elapsed time / engine and focus
  the preview after extraction (`d4d2f31`).

### Docs

- README (EN) and README_ZH, plus `docs/index.md` architecture and feature
  documentation updated throughout the release (`0d866e9`, `1aa62eb`,
  `b9375b3`, `a1929e0`, `219b97e`, `838bdea`).

---

_Commit range: `474ef1f` (first commit) → `df32360`
(`feat: add configuration backup/restore and release update check`).
45 commits._
