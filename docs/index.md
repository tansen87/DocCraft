# DocCraft

A cross-platform **PDF → Markdown** and **Markdown → Excel** desktop converter
built with [Tauri 2](https://tauri.app), React, TypeScript,
[shadcn/ui](https://ui.shadcn.com) and
[`pdf-inspector`](https://crates.io/crates/pdf-inspector) (Firecrawl's pure-Rust
PDF classification / extraction engine). The UI is bilingual - English (default)
and Simplified Chinese - switchable at runtime.

> Chinese architecture design document: [docs/architecture.md](./architecture.md)

## Features

- **Hybrid text + OCR conversion** - text pages are extracted locally by
  `pdf-inspector`; pages that need OCR (scanned / image-only / undecodable
  fonts) are rendered to PNG and sent to either a configured remote AI vision
  provider **or** the built-in local PaddleOCR engine (`ocr-rs`). Per-page
  results are reassembled in document order, so page 1 & 3 (text) and page 2
  (scan) come out as 1 → 2 → 3.
- **Smart PDF routing** - `pdf-inspector` classifies each PDF (~10–50ms) as
  `TextBased` / `Scanned` / `ImageBased` / `Mixed` and reports exactly which
  pages need OCR (`pages_needing_ocr`). Pure-text PDFs never touch the network.
  Because classification and per-page OCR flagging can disagree (a `Mixed` doc
  may have image pages that are never flagged), the backend also OCRs every
  page whose local text extraction came up empty whenever OCR is enabled - so
  image-only pages are never silently dropped.
- **Local markdown extraction** - headings, lists, code blocks, tables, links,
  and repeated-header/footer stripping - no OCR needed for native text PDFs.
  Every converted page is delimited by a `<!-- Page N -->` marker, which lets
  downstream tooling like the Excel export attribute tables to their source
  page. The preview can surface these markers as visible **"Page N" dividers**,
  and both the render and raw preview tabs paginate by marker, rendering pages
  lazily so large documents are never parsed in full at once.
- **Configurable OCR providers** - any **OpenAI-chat-completions-compatible**
  vision API (`base_url`, per-vendor multiple models) **or** the built-in
  **local PaddleOCR** engine (no network required). API keys are encrypted at
  rest (DPAPI on Windows) and never sent back to the frontend. Each model can
  be marked with a ★ **default** flag; the backend prefers a vendor that has a
  default model and uses that model (falling back to the first keyed vendor /
  first model otherwise). A unified **OCR mode** selector offers five options:
  `ForceLocal` (always local PaddleOCR), `ForceAi` (always remote AI vision),
  `NonTextLocal` (local OCR only for pages without extracted text),
  `NonTextAi` (remote OCR only for pages without extracted text), and
  `Disabled` (no OCR - scanned pages are skipped and never leave the machine).
- **Graceful OCR fallback** - when no usable OCR provider is configured (AI
  mode) or the local engine is unavailable, the conversion still completes:
  pages flagged for OCR are skipped (marked with a `<!-- OCR 跳过 … -->`
  comment) and recorded instead of failing the document. Per-page OCR failures
  degrade to a `<!-- OCR 失败 … -->` comment as well. A **bell icon** at the
  far right of the status bar collects these as structured notices - severity
  colored, unread badge, clear-all - with clickable page chips (long lists
  collapse to first/last pages with prev/next stepping and a jump input) that
  scroll the PDF preview to that page, plus a retry action.
- **OCR confidence display** - local PaddleOCR results report an average
  confidence score (0–1) exposed in the status bar, image list, and screenshot
  result popup, so users can gauge recognition quality at a glance.
- **Batch queue with configurable concurrency** - multi-file drag & drop,
  worker-pool conversion, retry / remove / export-all, and a user-adjustable
  concurrency limit (1–16, default 1) persisted in app settings.
- **Editor-style workspace** - top toolbar (file name + convert action),
  split-view middle (PDF preview | Markdown preview) and a bottom status bar
  (PDF type, pages, confidence, OCR needs, a notices bell and a live activity
  indicator showing the current extraction/OCR stage, e.g. "Recognizing page
  3/12").
- **Custom title bar + glassmorphism UI** - a custom window title bar
  (`WindowControls`) with minimize / maximize / close; the main window and
  snip result popup use a frosted-glass (`GlassPanel`) backdrop-blur effect
  whose opacity is independently tunable (0–100) per window. The blur can be
  toggled globally (`glassBlurEnabled`); on Windows it uses native acrylic.
  Opacity values sync across windows via `GlassOpacityContext`.
- **Whole-window drag & drop** - drop any PDF anywhere in the window; a drag
  overlay confirms the drop target; auto-detect runs immediately on select.
- **PDF region exclusion** - before conversion, draw rectangular exclusion
  regions over PDF pages to suppress unwanted content (headers, watermarks,
  page numbers). Exclusions can be applied per-page or to all pages at once.
  Both `convert_pdf` and the hybrid session path accept an `exclusions`
  payload. See [design/00010_pdf-exclude-region.md](./design/00010_pdf-exclude-region.md).
- **Paragraph mode** - configurable line-break policy for how extracted text
  lines are joined: **Guided** (default) merges wrapped lines only within
  user-selected table columns, **Smart** merges soft line breaks inside
  paragraphs, and **None** merges every non-structural line of a page.
  Screenshot OCR results also follow the selected paragraph mode.
  See [design/00013_pdf-line-break-mode.md](./design/00013_pdf-line-break-mode.md)
  and [design/00015_guided-paragraph-mode.md](./design/00015_guided-paragraph-mode.md).
- **Markdown → Excel** - batch-analyze `.md` files, auto-detect tables
  (count + lines), preview each file as a rendered/raw **markdown preview**
  (the same `PreviewPane` used by PDF → Markdown, with an "Export to Excel"
  action), and export to `.xlsx` (single file or export-all into a chosen
  directory). A **tables-only** mode (configurable in Settings) exports only
  GFM tables; when off, the whole document content is written into the
  workbook. Because the preview reuses the paginated, lazy-rendered pane and
  the backend returns the file content up front, even files with hundreds of
  tables / thousands of lines stay responsive without a second read of the
  file. Each table in the workbook is labeled with its source PDF page
  (`Page N`) when the file was produced by this app's PDF conversion;
  otherwise it falls back to `Table N`.
- **Draw-a-table extraction** - in the PDF workspace, manually draw vertical
  and horizontal separators over a rendered page to define table regions, then
  extract them into the Markdown output (undo/redo, per-page lines, Enter to
  extract). Supports **"apply to all pages"** mode with optional page limit
  (e.g. first 5 pages) for quick preview. Text extraction is cached per
  document and page-filtered to avoid redundant decoding. Each extracted block
  is prefixed with its source page's `<!-- Page N -->` marker, so merged tables
  keep their page attribution in the preview and Excel export. Pages **without
  a text layer** (scans / image-only pages) fall back to the **local PaddleOCR**
  engine: the frontend renders those pages to PNG (in batches of 6), the
  backend recognizes positioned text blocks and cuts them by the drawn column
  boundaries exactly like text-layer content. The fallback follows the selected
  **OCR mode**: `forceLocal` / `nonTextLocal` use the on-device PaddleOCR
  engine, while `forceAi` / `nonTextAi` send the rendered page to the configured
  remote AI vision provider together with the drawn separator positions (as
  percentages) and parse the GFM answer directly - the model is asked to cut
  the table by the user-drawn lines. `disabled` keeps draw-table extraction
  text-layer-only, and missing local models or an unconfigured provider degrade
  silently to empty results instead of failing. Exclusion regions can be
  applied to draw-table extraction as well
  ([design/00011_draw-line-exclude-region.md](./design/00011_draw-line-exclude-region.md)).
  A **high-precision** mode (configurable) renders scanned-page OCR images at
  ~288 DPI and cuts recognized text blocks by width-weighted character centers
  for more accurate column boundaries.
- **Image → Markdown** - a dedicated workspace tab accepts PNG / JPEG images
  (drag & drop anywhere or file picker, deduplicated list with thumbnails).
  Each image is recognized by the OCR engine selected by the current
  **OCR mode** (local PaddleOCR or remote AI vision; `disabled` reports an
  error since a bare image has nothing else to extract). Recognition runs
  through a worker pool bounded by the global concurrency setting with live
  progress ("Recognizing image 3/10") in the status bar; failed images raise
  an error notice whose chips locate and highlight the row, plus a retry
  action. Results are previewed as one merged GFM document (`---`-separated)
  or individually - click a row or use the preview-header picker to focus any
  single image's markdown (copy / export act on whatever is shown), and every
  recognized image can be exported per-file or merged into a single `.md`.
  Tables inside imported images can also be extracted by drawing vertical
  column separators over them (local PaddleOCR block cutting or AI vision
  with drawn-line hints). See [image-to-markdown.md](./image-to-markdown.md)
  for the design notes.
- **Screenshot recognition** - press the global hotkey (default `F8`,
  re-recordable by pressing a key combination in Settings) and the monitor
  under the cursor freezes into a full-screen region-selection overlay with a
  cursor-following tool palette (magnifier, physical coordinates, color
  picker). Drag a rectangle (or double-click for full screen) to OCR exactly
  that region - Esc / right-click cancels. Overlay windows are created once
  per monitor and reused (hidden between captures) so the hotkey-to-overlay
  latency stays low; snapshots are JPEG-previews while cropping / OCR always
  use the raw frame, and results land in the Image → Markdown list like any
  imported file (retry / export included). Screenshot results follow the
  selected **paragraph mode** and can optionally show a glassmorphism result
  popup (pin / copy / clear) and auto-copy to clipboard. Performance notes
  live in [design/00001_snip-performance.md](./design/00001_snip-performance.md).
- **Local layout analysis** - for OCR pages, three layout analysis modes
  (`ocrLayoutMode`): **off** (default, pure Y→X line sorting), **rule**
  (zero-model geometric heuristics: XY-Cut column detection, heading font-size
  heuristic, header/footer band filtering), and **paddle** (MNN PicoDet layout
  model with configurable confidence threshold; degrades to `rule` when the
  model is missing). Four bundled layout models are available under
  `resources/models/layout/`. See
  [design/00016_local-ocr-layout-analysis.md](./design/00016_local-ocr-layout-analysis.md).
- **Local usage statistics** - every conversion / extraction / screenshot is
  logged locally (JSONL) with file count, page count, OCR pages, engine type,
  and wall-clock duration. The Settings page shows aggregated counters for
  today, this month, and all time (files, pages, OCR breakdown by local vs.
  AI engine, total time). Data never leaves the device; the log can be cleared
  from Settings.
- **System tray** - optional tray icon (on by default) with Open DocCraft /
  Start Screenshot / Exit menu items; closing the window hides to tray
  instead of quitting when enabled.
- **Bilingual UI (i18n)** - English (default) and 中文 (Simplified Chinese)
  switched via a dropdown next to the theme toggle; the choice persists in
  `localStorage` and every string goes through a typed translation layer.
- **Settings page** - sidebar navigation over scroll-synced sections styled as
  grouped panels with hairline-separated setting rows ("Soft Rows" layout, see
  [design/00002_settings-ui-redesign.md](./design/00002_settings-ui-redesign.md)):
  vendor/model/key management, OCR mode selector, local-engine caching
  toggle, press-to-record hotkey field, custom AI prompts, layout analysis
  mode/model selection, paragraph mode, unsaved-changes floating save pill,
  and responsive collapse for narrow windows. A **usage statistics** card
  displays local conversion counters.
- **Config backup & restore** - export all app settings plus OCR vendors
  into one JSON file (API keys excluded by default; including them stores
  plaintext after an explicit warning), and import such a file again:
  vendors merge by id (local entries missing from the file are kept,
  plaintext keys are re-encrypted on import) and settings go through the
  same side-effect pipeline as a manual save (hotkey re-registration, tray
  sync, engine-cache release).
- **Update check** - the header (next to the language toggle) has a manual
  check button; a non-blocking amber badge appears there automatically when
  the once-per-session startup check finds a newer release. Both open a
  dialog rendering the release notes as markdown (`core/update.rs` queries
  the GitHub Releases API with a 10s timeout), and the dialog's "update"
  button navigates to the releases page. Up-to-date / offline cases degrade
  to toasts.

## Tech Stack

| Layer   | Choice |
|---------|--------|
| Desktop framework | Tauri 2.x (WebView + Rust core), asset protocol enabled for local file preview, `tray-icon` feature |
| Frontend          | React 19 + TypeScript 7 + Vite 8 |
| UI kit            | shadcn/ui (Radix primitives, Tailwind CSS v4) |
| Package manager   | pnpm 10 |
| PDF engine        | `pdf-inspector` 1.17 (pure Rust, `lopdf`) |
| Local OCR engine  | `ocr-rs` 2.4 (PaddleOCR, pure Rust) - engine cached in-process (toggleable); tiny / small / medium tiers |
| Layout analysis   | 4 bundled PicoDet / PP-DocLayout models via MNN (optional, `ocrLayoutMode` = `paddle`) |
| Screen capture    | `xcap` 0.9 (monitor snapshots) + `tauri-plugin-global-shortcut` (hotkey) |
| PDF preview / OCR images | `pdfjs-dist` 6.x (renders preview pages; also renders OCR pages to PNG for the backend) |
| Markdown / Excel  | `react-markdown` + GFM on the frontend; `rust_xlsxwriter` on the backend for `.xlsx` export |
| i18n              | custom lightweight React Context layer (no external dep), typed en/zh dictionaries |
| HTTP client       | `reqwest` 0.13 (async, native-tls) |
| Secret storage    | DPAPI via `windows-sys` (Win32_Security_Cryptography) on Windows |
| Concurrency       | frontend worker pool (limit from app settings) |
| Config storage    | JSON files in `app_config_dir` (`ocr-config.json`, `app-settings.json`) |

## Project Structure

```
doccraft/
├─ docs/
│  ├─ index.md                   # This file
│  ├─ changelog/                 # Version changelogs
│  └─ design/                    # Design proposal documents
├─ src/                          # React frontend
│  ├─ components/
│  │  ├─ header-actions.tsx      # Manual update check + "new version" badge
│  │  ├─ pdf2md/                 # PDF → Markdown workflow
│  │  │  ├─ convert-workspace.tsx# Workspace: detect → convert → preview
│  │  │  ├─ convert-toolbar.tsx  # Top toolbar (file info + convert CTA)
│  │  │  ├─ drop-zone.tsx        # Full-area pick / drag target (empty state)
│  │  │  ├─ drag-overlay.tsx     # Whole-window drag overlay
│  │  │  ├─ use-pdf-drop.ts      # Whole-window drag & drop hook
│  │  │  ├─ pdf-preview.tsx      # pdf.js inline preview (ScrollArea + dark mode)
│  │  │  ├─ preview-pane.tsx     # Markdown preview (render / raw toggle, paginated + lazy; line-chunked for marker-less docs)
│  │  │  ├─ render-pdf-pages.ts  # Renders OCR pages to PNG base64 for the backend
│  │  │  ├─ exclude-overlay.tsx  # PDF region exclusion overlay
│  │  │  ├─ exclude-panel.tsx    # PDF region exclusion panel
│  │  │  └─ status-bar.tsx       # Bottom status (type / pages / confidence / OCR)
│  │  ├─ draw-table/             # Manual "draw-a-table" extraction
│  │  │  ├─ draw-table-toolbar.tsx
│  │  │  ├─ draw-table-panel.tsx # Overlay + per-page lines + undo/redo
│  │  │  ├─ canvas-overlay.tsx   # Draw/edit vertical + horizontal separator lines
│  │  │  └─ pdf-preview-with-draw.tsx
│  │  ├─ img2md/
│  │  │  └─ image-preview-pane.tsx # Image preview for img2md workspace
│  │  ├─ snip/snip-overlay.tsx    # Per-monitor region-selection overlay (magnifier + color picker)
│  │  ├─ image-table/             # Draw-a-table extraction on imported images
│  │  │  └─ image-table-overlay.tsx
│  │  ├─ layout/
│  │  │  ├─ app-header.tsx       # Top bar (brand, tabs, language + theme toggles)
│  │  │  └─ window-controls.tsx  # Custom title bar (minimize / maximize / close)
│  │  ├─ language-toggle.tsx     # English / 中文 dropdown
│  │  ├─ theme-toggle.tsx
│  │  └─ ui/                     # shadcn/ui components (incl. glass-panel.tsx, status-badge.tsx)
│  ├─ i18n/
│  │  ├─ index.tsx               # LanguageProvider + useI18n() + t() interpolation
│  │  └─ translations.ts         # Typed en/zh dictionaries (TranslationKey)
│  ├─ lib/
│  │  ├─ ipc.ts                  # Tauri invoke() wrappers
│  │  ├─ types.ts                # Shared IPC DTO types
│  │  ├─ concurrency.ts          # Shared max-concurrent cache (default 1)
│  │  ├─ format-duration.ts      # Shared ms → human duration formatter
│  │  ├─ pdf-meta.ts             # PDF-type → badge/icon mapping
│  │  ├─ exclude-region.ts       # Exclusion region helpers
│  │  ├─ glass-opacity.ts        # GlassOpacityContext + useGlassOpacity hook
│  │  ├─ global-task.ts          # Cross-tab running task indicator
│  │  ├─ usage.ts                # Usage recording helper
│  │  └─ utils.ts                # cn() helper
│  ├─ views/
│  │  ├─ pdf-to-md.tsx           # Batch queue + single-file PDF workspace
│  │  ├─ image-to-md.tsx         # Image → Markdown (OCR) list + merged preview
│  │  ├─ md-to-xlsx.tsx          # Markdown → Excel batch list + preview
│  │  └─ settings.tsx            # Settings (grouped-panel layout, usage stats card)
│  ├─ App.tsx                    # App shell, tab switching (PDF/IMG → MD / MD → XLSX / settings)
│  ├─ index.css                  # Tailwind v4 + design tokens
│  └─ main.tsx                   # Entry; routes `snip-*` windows to the overlay
├─ src-tauri/                    # Rust backend
│  ├─ src/
│  │  ├─ lib.rs                  # Tauri commands + run()
│  │  ├─ main.rs
│  │  ├─ models.rs               # Serialized DTOs (camelCase for the frontend)
│  │  └─ core/
│  │     ├─ convert.rs           # detect / convert / export wrappers
│  │     ├─ ocr.rs               # Hybrid conversion, OCR HTTP client, local PaddleOCR engine (+cache)
│  │     ├─ snip.rs              # Screenshot capture / region OCR / hotkey registration
│  │     ├─ settings.rs          # OCR config + app settings persistence
│  │     ├─ config_transfer.rs   # Configuration export / import (merge by id)
│  │     ├─ update.rs            # Lightweight release update check (latest.json)
│  │     ├─ secret.rs            # API key protection (DPAPI / obfuscation)
│  │     ├─ line_draw.rs         # Manual "draw-a-table" vertical-line extraction
│  │     ├─ md_to_xlsx.rs        # Markdown → Excel table parsing + export
│  │     ├─ grid_rebuild.rs      # Grid/region reconstruction from drawn lines
│  │     ├─ page_marker.rs       # `<!-- Page N -->` marker parsing + page attribution
│  │     ├─ extract_cache.rs     # Per-document text extraction cache for draw-table
│  │     ├─ layout.rs            # Local layout analysis (off / rule / paddle modes)
│  │     ├─ paragraph.rs         # Paragraph line-break mode logic (guided / smart / none)
│  │     ├─ region_exclude.rs    # PDF region exclusion backend
│  │     └─ usage_stats.rs       # Local usage statistics (JSONL log + aggregation)
│  ├─ resources/models/
│  │  ├─ *.mnn                   # Tiny + Small PaddleOCR model tiers
│  │  └─ layout/                 # 4 bundled layout models (PP-DocLayout-S, PicoDet-*)
│  ├─ capabilities/              # Permissions (main window + snip-* overlays)
│  ├─ tauri.conf.json            # assetProtocol enabled for PDF preview
│  └─ Cargo.toml
├─ script/
│  └─ convert_paddle_to_mnn.py   # PaddleOCR → MNN model conversion tooling
├─ index.html
├─ package.json
└─ vite.config.ts
```

## IPC Contract

Commands (invoked from `src/lib/ipc.ts`):

| Command              | Input                                   | Output                       |
|----------------------|-----------------------------------------|------------------------------|
| `detect_pdf`         | `{ path }`                              | `DetectResult` (type, confidence, pages needing OCR, layout) |
| `convert_pdf`        | `{ path, pageRange?, exclusions? }` - `pageRange` (`"1-5,8,12-14"`) optionally limits output pages; `exclusions` suppresses content within user-drawn regions | `ConvertResult` (`DetectResult` + `markdown` + `processingTimeMs` + `ocrConfidence`) |
| `hybrid_session_start` | `{ path, ocrPages, pageRange?, exclusions? }` - 1-indexed pages needing OCR; `pageRange` optionally limits text extraction; `exclusions` suppresses content within user-drawn regions | `HybridSessionInfo` (sessionId + `ocrConfigured` + detect info; text pages extracted once and kept on the backend; no engine → OCR pages are skipped, not failed) |
| `hybrid_page_ocr`    | `{ sessionId, page, imagePng }` - one rendered page | `string` - that page's markdown (local PaddleOCR or remote AI; OCR failures degrade to a `<!-- OCR 失败 … -->` comment) |
| `hybrid_session_finish` | `{ sessionId }`                       | `ConvertResult` - text + OCR pages reassembled in document order; reports `skippedPages` and `failedPages` |
| `hybrid_session_abort` | `{ sessionId }`                      | `void` (discards an abandoned session) |
| `export_markdown`    | `{ path, content }`                     | `void` (writes markdown to file) |
| `get_ocr_config`     | -                                       | `OcrVendor[]` (keys never returned, only `apiKeySet`) |
| `save_ocr_config`    | `{ vendors }`                           | `void` (merges/encrypts API keys) |
| `reveal_ocr_key`     | `{ vendorId }`                          | `string \| null` (decrypted key, "show key") |
| `get_app_settings`   | -                                       | `AppSettings` (see Configuration section) |
| `set_app_settings`   | `{ settings }`                          | `void` (clamped 1–16) |
| `list_layout_models` | -                                       | `LayoutModelInfo[]` (dir, displayName, classCount, buckets, available) |
| `record_usage`       | `{ entry: UsageInput }` - kind, fileCount, pageCount, ocrPageCount, engine, totalMs, date | `void` (appends to local JSONL log) |
| `get_usage_stats`    | `{ today: "YYYY-MM-DD" }`              | `UsageStats` (today / month / total with pdfFileCount, pdfPageCount, imageFileCount, localOcrPageCount, aiOcrPageCount, totalMs) |
| `clear_usage_stats`  | -                                       | `void` (deletes the local usage log) |
| `export_config`      | `{ path, includeSecrets }`              | `usize` - vendors written; keys plaintext only when opted in |
| `import_config`      | `{ path }`                              | `ImportResult` (`vendorsImported`, `settingsApplied`); merges by id, applies settings with full side effects |
| `check_for_update`   | -                                       | `UpdateInfo \| null` (`version`, `title`, `notes`, `url`, `isNewer`) |
| `analyze_markdown`   | `{ path }`                              | `MdAnalyzeResult` (`tableCount`, `tables[]` with columns/rows/page, `totalRows`, `totalLines`, `content`, `processingTimeMs`) |
| `export_markdown_tables` | `{ mdPath, xlsxPath }`              | `MdExportResult` (`tableCount`, `totalRows`, `processingTimeMs`) |
| `extract_draw_table` | `{ path, drawData }` - `drawData` may carry `totalPages`, `onlyPages` (batching), `pageImages[]` (`{page, imagePng, renderScale}`) for the mode-selected OCR fallback, and `exclusions` | `DrawTableResult` (`tableCount`, `tables[]`, `regions[]`, `totalRows`, `ocrPages`, `emptyTextPages`, `ocrConfidence`, `processingTimeMs`) |
| `extract_draw_table_to_markdown` | `{ path, drawData, existingMarkdown? }` | `string` - merged markdown with extracted tables appended |
| `ocr_image_to_md`    | `{ path }` - a PNG / JPEG file          | `OcrImageResult` (`markdown`, `engine`: `"local" \| "ai"`, `durationMs`, `ocrConfidence`) |
| `screenshot_begin`   | - (hides nothing; freezes the monitor under the cursor) | `MonitorSnapshot[]` (`dataUrl` JPEG preview + geometry; raw frame cached server-side) |
| `screenshot_ocr`     | `{ region }` - `ShotRegion` in physical px | `OcrImageResult` (+`pngBase64` thumbnail, `savedPath`); consumes the cached snapshot |
| `screenshot_cancel`  | -                                       | `void` (drops cached snapshots) |
| `get_window_under_cursor` | -                                  | `WindowInfo` (`title`, `className`, rect) |
| `ocr_image_table`    | `{ request: ImageTableRequest }` - `imagePath`, `verticalLines[]`, optional `horizontalLines[]`, optional `guided` config | `ImageTableResult` (GFM table cut at the drawn lines, `engine`, `durationMs`) |

Hotkey path: the global shortcut emits `snip:ready` (snapshots) directly to
the frontend, avoiding an IPC round-trip; overlays report back via
`snip:selected` / `snip:cancelled` events.

Result fields are serialized in camelCase; `PdfTypeDto` mirrors `pdf-inspector`'s
`PdfType` enum (`TextBased` / `Scanned` / `ImageBased` / `Mixed`).
`OcrMode` is a string union (`forceLocal` / `forceAi` / `nonTextLocal` /
`nonTextAi` / `disabled`).

## Rust ↔ Frontend Data Flow

```
[1] User drops / picks a PDF        → whole-window drag & drop or dialog plugin → absolute path
[2] detect_pdf(path)                → auto-runs on select → classification + OCR routing signals
[3] Convert (OCR disabled / nonText modes with no OCR needed)
    convert_pdf(path, exclusions?)  → pdf-inspector::process_pdf → full local Markdown
                                     (exclusions suppress content within user-drawn regions)
[4] Convert (OCR enabled - forceLocal / forceAi / nonTextLocal / nonTextAi)
    startHybridSession(path, N, exclusions?)
                                   → backend extracts text pages once, resolves OCR engine;
                                     local PaddleOCR or remote AI vision provider;
                                     nonText modes also add any page whose local text
                                     extraction is empty (image-only pages); when no
                                     engine is available → pages are skipped and recorded
    renderPdfPagesForOcr(path, N)  → pdf.js renders ONE OCR page to PNG (base64) at a time
                                     (skipped entirely when local OCR is selected)
    hybrid_page_ocr(session, p, im)→ local PaddleOCR or remote OCR provider, one page at a time
    hybrid_session_finish(session) → reassemble in doc order; abort on cancel/error
[5] PDF preview                    → pdf.js fetches file via asset protocol → canvas pages
[6] Markdown preview / export      → paginated raw / rendered views (lazy per page), copy, save via dialog
```

`hybrid_page_ocr` runs async so OCR never blocks the UI, and pages are
streamed one at a time so peak memory stays at a single page image instead of
the whole document. For remote AI mode, API keys are decrypted only inside the
Rust process (`core::settings::api_key_for`) and sent as `Authorization:
Bearer`; the frontend never sees them. For local PaddleOCR mode, all processing
happens on-device with no network calls. Sessions are auto-pruned if the
frontend never finishes or aborts them.
Errors from `PdfError` are stringified and surfaced through toast notifications.
When OCR isn't available (mode is `disabled`, no remote provider configured, or
local engine unavailable), `finish_session` returns a successful `ConvertResult`
whose `skippedPages` lists every page that needed OCR, and each skipped page
appears in the markdown as a `<!-- OCR 跳过 … -->` comment; failed pages are
tracked the same way via `failedPages`.

## Internationalization (i18n)

A small custom layer (no external dependency) keeps every UI string bilingual:

- `src/i18n/translations.ts` - two dictionaries, `en` (default) and `zh`.
  The `TranslationKey` type is derived from the `en` keys, and `zh` is typed
  as `Record<TranslationKey, string>`, so adding a key to one language fails
  type-check until it exists in both.
- `src/i18n/index.tsx` - `LanguageProvider` + the `useI18n()` hook. It exposes
  `t(key, params?)` which interpolates `{param}` placeholders (e.g.
  `t("batch.completed", { done, total })`). The active language is persisted in
  `localStorage` (`doccraft-language`, default `en`).
- `src/components/language-toggle.tsx` - a dropdown button next to the theme
  toggle in the app header (English / 中文, native labels). Views and shared
  components consume translations through `t()`; toasts, tooltips, dialogs,
  drag-drop overlays and status badges are all covered.

## Getting Started

Prerequisites: Node ≥ 20, pnpm ≥ 10, Rust toolchain (stable).

```bash
pnpm install            # install frontend deps
pnpm tauri dev          # run the desktop app (HMR + debug build)
```

Useful checks:

```bash
pnpm exec tsc --noEmit   # frontend type check
pnpm build               # frontend production build (tsc + vite build)
cargo check --manifest-path src-tauri/Cargo.toml
```

## Roadmap

- **M1 (done)** - Scaffold (Tauri + React + shadcn), IPC, single-file local
  PDF → Markdown with editor-style preview workspace: whole-window drag & drop,
  auto-detect, pdf.js inline PDF preview (ScrollArea, dark mode), status bar.
- **M2 (done)** - OCR pipeline: sidebar settings page (OpenAI-compatible
  vendors / models / API keys + local PaddleOCR engine via `ocr-rs`), unified
  `OcrMode` selector (forceLocal / forceAi / nonTextLocal / nonTextAi /
  disabled), page rendering via pdf.js, hybrid conversion that routes text
  pages to pdf-inspector and scanned pages to the configured OCR engine,
  reassembled in document order.
- **M3 (mostly done)** - Batch processing: worker pool with a user-configurable
  concurrency limit (settings → Concurrent threads, default 1), retry / remove /
  export-all. (Live progress events & per-file OCR cancellation still optional.)
- **M3.5 (done)** - **Markdown → Excel**: batch `.md` analysis, auto table
  detection, markdown preview (reusing the PDF → Markdown `PreviewPane` with
  rendered/raw toggles and lazy rendering, now including line-based chunking
  for marker-less documents), and `.xlsx` export (single or all) with
  configurable **tables-only** mode. Plus manual **draw-a-table** extraction
  for scanned PDF regions (vertical-line-only mode, "apply to all pages" with
  page limit, page-filtered text extraction, extraction caching, and a local
  PaddleOCR fallback for pages without a text layer).
- **M4 (mostly done)** - Polish: **bilingual i18n (en/zh, runtime toggle)**
  and dark mode. **Large-document performance**: the Markdown preview renders
  lazily and paginated (per-page markers, plus line-based chunking for
  marker-less documents, via IntersectionObserver with real-height
  placeholders), so big files no longer freeze the UI. **Settings page**
  restructured into a scrollable
  waterfall layout with grouped panels (design/00002_settings-ui-redesign.md).
  **Image → Markdown** workspace tab: PNG / JPEG images recognized via the
  selected OCR mode with a concurrency-bounded worker pool, merged or
  per-image export, and status-bar notices for failures.
- **M5 (done)** - **Screenshot recognition**: global hotkey → frozen
  full-screen overlay with magnifier / coordinates / color picker → drag a
  region → OCR result lands in the Image → Markdown workspace. Overlay
  windows are reused across captures, snapshots use JPEG previews with raw
  frames for exact crops, the local OCR engine stays resident (toggleable),
  and remote AI calls share one HTTP connection pool - see
  [design/00001_snip-performance.md](./design/00001_snip-performance.md).
- **M5.5 (done)** - **Custom title bar + glassmorphism UI**: custom window
  controls, frosted-glass backdrop-blur effect with tunable per-window
  opacity, native acrylic on Windows, blur toggle.
  **PDF region exclusion**: draw rectangles to suppress unwanted content during
  conversion; "apply to all pages" mode.
  **Paragraph mode**: configurable line-break policy (guided / smart / none)
  for PDF text pages and OCR results; guided mode merges within user-selected
  table columns.
  **Local layout analysis**: off / rule (geometric heuristics) / paddle (MNN
  PicoDet model) for OCR page reading order; 4 bundled layout models.
  **Usage statistics**: local JSONL logging with aggregated counters in
  Settings (today / month / total).
  **Custom AI prompts**: configurable prompts for document OCR and draw-table
  extraction paths.
  **OCR confidence display**: local PaddleOCR confidence shown in status bar,
  image list, and snip result.
  **Tiny model tier**: new fastest PaddleOCR tier alongside small (default)
  and medium.
- **Design docs** - numbered proposals live under
  [docs/design/](./design/) (`00001` through `00016`).
- **Changelogs** - version release notes live under
  [docs/changelog/](./changelog/).

## Configuration

- `ocr-config.json` (per-vendor): name, base URL, protected API key
  (`v1:<DPAPI-encrypted hex>` on Windows, `obf:` fallback elsewhere),
  list of models (each with a `default` flag; a ★-marked model is the one used
  for OCR).
- `app-settings.json`:
  - `maxConcurrent` (1–16, default 1) driving the batch worker-pool size
  - `cacheExtractedText` (default `true`) - when on, the line-draw table
    extraction decodes the current PDF's text once and reuses it across
    draw/merge calls; toggle it off for very large documents to free memory
  - `excelTablesOnly` (default `false`) - when on, only GFM tables are
    exported to Excel; when off, the whole document content is written into
    the workbook
  - `ocrMode` (default `disabled`), a unified OCR mode with five options:
    `forceLocal` (always local PaddleOCR), `forceAi` (always remote AI
    vision), `nonTextLocal` (local OCR only for pages without extracted text),
    `nonTextAi` (remote OCR only for pages without extracted text), and
    `disabled` (no OCR - pages needing OCR are skipped and never leave the
    machine). When OCR is enabled, conversion routes through the hybrid
    session and - in addition to the pages detection flagged - any page whose
    local text extraction produced no content is also sent to the OCR engine.
    The draw-table extraction shares the same mode selector: local modes
    (`forceLocal` / `nonTextLocal`) enable its on-device PaddleOCR fallback
    for scanned pages, AI modes (`forceAi` / `nonTextAi`) enable the remote
    vision fallback with drawn-line hints, and `disabled` keeps it
    text-layer-only.
  - `screenshotHotkey` (global hotkey accelerator, default `F8`, empty disables)
  - `textSeparator` (joins same-line OCR blocks: `" "` / `","` / `"|"` /
    tab / `"^"`, default `"|"`)
  - `enableTray` (default `true`, system tray icon with close-to-tray
    behaviour)
  - `ocrLowPrecision` (default `true` - MNN f16 mode, ~30–50% faster on CPU);
    changing rebuilds the resident engine(s)
  - `ocrModelSize` (`"tiny"` / `"small"` (default) / `"medium"` - which
    bundled PaddleOCR tier to load; tiny is fastest, small is ~2–3× faster
    than medium)
  - `drawTableHighPrecision` (default `true` - renders scanned-page OCR
    images at ~288 DPI and cuts by width-weighted character centers for more
    accurate column boundaries)
  - `aiOcrPrompt` (custom prompt for remote AI document-OCR path; empty
    string uses built-in default)
  - `drawTablePrompt` (custom prompt for remote AI draw-table path; empty
    string uses built-in default)
  - `paragraphMode` (default `"guided"` - how extracted text lines are joined:
    `"guided"` merges within user-selected table columns, `"smart"` merges
    soft line breaks inside paragraphs, `"none"` merges every non-structural
    line)
  - `localOcrThreads` (default `0` = auto-detect; 1–16 for explicit thread
    count for local PaddleOCR MNN inference)
  - `ocrLayoutMode` (default `"off"` - layout analysis for local OCR pages:
    `"off"` (pure Y→X sorting), `"rule"` (geometric heuristics: XY-Cut
    columns, heading detection, header/footer filtering), `"paddle"` (MNN
    PicoDet model, degrades to `"rule"` when model is missing))
  - `ocrLayoutModel` (default `"PP-DocLayout-S"` - subdirectory under
    `resources/models/layout/` carrying `model.mnn` + `layout-meta.json`)
  - `layoutScoreThreshold` (default `0.5` - confidence threshold for Paddle
    layout detections; `paddle` mode only)
  - `layoutDropHeaderFooter` (default `true` - drop `page_header` /
    `page_footer` regions instead of keeping as HTML comments; `paddle` mode
    only)
  - `snipResultPopup` (default `true` - show result popup after screenshot
    recognition)
  - `snipAutoCopy` (default `true` - auto-copy screenshot result to clipboard)
  - `snipResultOpacity` (default `60` - glassmorphism opacity for snip result
    window, 0–100)
  - `mainWindowOpacity` (default `100` - glassmorphism opacity for main
    window, 0–100)
  - `glassBlurEnabled` (default `true` - frosted-glass blur effect toggle)

Both live in the Tauri `app_config_dir` directory. No third-party store plugin
is required. For privacy, only pages that need OCR (detected or empty
extraction) are ever sent to an external OCR provider; local PaddleOCR mode
keeps all data on-device.

## License

MIT (project scaffold per `create-tauri-app`; `pdf-inspector` is MIT).
