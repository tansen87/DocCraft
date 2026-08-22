# DocCraft

A cross-platform **PDF → Markdown** and **Markdown → Excel** desktop converter
built with [Tauri 2](https://tauri.app), React, TypeScript,
[shadcn/ui](https://ui.shadcn.com) and
[`pdf-inspector`](https://crates.io/crates/pdf-inspector) (Firecrawl's pure-Rust
PDF classification / extraction engine). The UI is bilingual — English (default)
and Simplified Chinese — switchable at runtime.

> Chinese architecture design document: [docs/architecture.md](./architecture.md)

## Features

- **Hybrid text + OCR conversion** — text pages are extracted locally by
  `pdf-inspector`; pages that need OCR (scanned / image-only / undecodable
  fonts) are rendered to PNG and sent to either a configured remote AI vision
  provider **or** the built-in local PaddleOCR engine (`ocr-rs`). Per-page
  results are reassembled in document order, so page 1 & 3 (text) and page 2
  (scan) come out as 1 → 2 → 3.
- **Smart PDF routing** — `pdf-inspector` classifies each PDF (~10–50ms) as
  `TextBased` / `Scanned` / `ImageBased` / `Mixed` and reports exactly which
  pages need OCR (`pages_needing_ocr`). Pure-text PDFs never touch the network.
  Because classification and per-page OCR flagging can disagree (a `Mixed` doc
  may have image pages that are never flagged), the backend also OCRs every
  page whose local text extraction came up empty whenever OCR is enabled — so
  image-only pages are never silently dropped.
- **Local markdown extraction** — headings, lists, code blocks, tables, links,
  and repeated-header/footer stripping — no OCR needed for native text PDFs.
  Every converted page is delimited by a `<!-- Page N -->` marker, which lets
  downstream tooling like the Excel export attribute tables to their source
  page. The preview can surface these markers as visible **"Page N" dividers**,
  and both the render and raw preview tabs paginate by marker, rendering pages
  lazily so large documents are never parsed in full at once.
- **Configurable OCR providers** — any **OpenAI-chat-completions-compatible**
  vision API (`base_url`, per-vendor multiple models) **or** the built-in
  **local PaddleOCR** engine (no network required). API keys are encrypted at
  rest (DPAPI on Windows) and never sent back to the frontend. Each model can
  be marked with a ★ **default** flag; the backend prefers a vendor that has a
  default model and uses that model (falling back to the first keyed vendor /
  first model otherwise). A unified **OCR mode** selector offers five options:
  `ForceLocal` (always local PaddleOCR), `ForceAi` (always remote AI vision),
  `NonTextLocal` (local OCR only for pages without extracted text),
  `NonTextAi` (remote OCR only for pages without extracted text), and
  `Disabled` (no OCR — scanned pages are skipped and never leave the machine).
- **Graceful OCR fallback** — when no usable OCR provider is configured (AI
  mode) or the local engine is unavailable, the conversion still completes:
  pages flagged for OCR are skipped (marked with a `<!-- OCR 跳过 … -->`
  comment) and recorded instead of failing the document. Per-page OCR failures
  degrade to a `<!-- OCR 失败 … -->` comment as well. A **bell icon** at the
  far right of the status bar shows the total skipped / failed count and, on
  hover, the exact page numbers.
- **Batch queue with configurable concurrency** — multi-file drag & drop,
  worker-pool conversion, retry / remove / export-all, and a user-adjustable
  concurrency limit (1–16, default 1) persisted in app settings.
- **Editor-style workspace** — top toolbar (file name + convert action),
  split-view middle (PDF preview | Markdown preview) and a bottom status bar
  (PDF type, pages, confidence, OCR needs, plus a skipped/failed notices bell).
- **Whole-window drag & drop** — drop any PDF anywhere in the window; a drag
  overlay confirms the drop target; auto-detect runs immediately on select.
- **Markdown → Excel** — batch-analyze `.md` files, auto-detect tables
  (count + rows), preview each table, and export to `.xlsx` (single file or
  export-all into a chosen directory). A **tables-only** mode (configurable in
  Settings) exports only GFM tables; when off, the whole document content is
  written into the workbook. The preview lazy-mounts table sections and
  windows rows as you scroll, so even files with hundreds of tables /
  thousands of rows stay responsive. Each table in the workbook is labeled
  with its source PDF page (`Page N`) when the file was produced by this app's
  PDF conversion; otherwise it falls back to `Table N`.
- **Draw-a-table extraction** — in the PDF workspace, manually draw vertical
  separators over a rendered page to define table regions, then extract them
  into the Markdown output (undo/redo, per-page lines, Enter to extract).
  Supports **"apply to all pages"** mode with optional page limit (e.g. first
  5 pages) for quick preview. Text extraction is cached per document and
  page-filtered to avoid redundant decoding. Each extracted block is prefixed
  with its source page's `<!-- Page N -->` marker, so merged tables keep their
  page attribution in the preview and Excel export. Pages **without a text
  layer** (scans / image-only pages) fall back to the **local PaddleOCR**
  engine: the frontend renders those pages to PNG (in batches of 6), the
  backend recognizes positioned text blocks and cuts them by the drawn column
  boundaries exactly like text-layer content. The fallback follows the
  selected **OCR mode**: `forceLocal` / `nonTextLocal` use the on-device
  PaddleOCR engine, while `forceAi` / `nonTextAi` send the rendered page to
  the configured remote AI vision provider together with the drawn separator
  positions (as percentages) and parse the GFM answer directly — the model is
  asked to cut the table by the user-drawn lines. `disabled` keeps draw-table
  extraction text-layer-only, and missing local models or an unconfigured
  provider degrade silently to empty results instead of failing.
- **Bilingual UI (i18n)** — English (default) and 中文 (Simplified Chinese)
  switched via a dropdown next to the theme toggle; the choice persists in
  `localStorage` and every string goes through a typed translation layer.
- **Sidebar settings page** — left navigation switches between **OCR 服务 /
  OCR Service** (vendors / models / keys + OCR mode selector), **并发线程 /
  Concurrency** (batch conversion concurrency), **缓存 / Cache** (text
  extraction caching toggle), and **Excel** (tables-only export toggle).

## Tech Stack

| Layer   | Choice |
|---------|--------|
| Desktop framework | Tauri 2.x (WebView + Rust core), asset protocol enabled for local file preview |
| Frontend          | React 19 + TypeScript + Vite 8 |
| UI kit            | shadcn/ui (Radix primitives, Tailwind CSS v4) |
| Package manager   | pnpm 10 |
| PDF engine        | `pdf-inspector` 1.14 (pure Rust, `lopdf`) |
| Local OCR engine  | `ocr-rs` 2.4 (PaddleOCR, pure Rust) |
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
│  ├─ ui-design.md               # Chinese UI/UX design notes
│  └─ index.md                   # This file
├─ src/                          # React frontend
│  ├─ components/
│  │  ├─ pdf2md/                 # PDF → Markdown workflow
│  │  │  ├─ convert-workspace.tsx# Workspace: detect → convert → preview
│  │  │  ├─ convert-toolbar.tsx  # Top toolbar (file info + convert CTA)
│  │  │  ├─ drop-zone.tsx        # Full-area pick / drag target (empty state)
│  │  │  ├─ drag-overlay.tsx     # Whole-window drag overlay
│  │  │  ├─ use-pdf-drop.ts      # Whole-window drag & drop hook
│  │  │  ├─ pdf-preview.tsx      # pdf.js inline preview (ScrollArea + dark mode)
│  │  │  ├─ preview-pane.tsx     # Markdown preview (render / raw toggle, paginated + lazy)
│  │  │  ├─ render-pdf-pages.ts  # Renders OCR pages to PNG base64 for the backend
│  │  │  └─ status-bar.tsx       # Bottom status (type / pages / confidence / OCR)
│  │  ├─ draw-table/             # Manual "draw-a-table" extraction
│  │  │  ├─ draw-table-toolbar.tsx
│  │  │  ├─ draw-table-panel.tsx # Overlay + per-page lines + undo/redo
│  │  │  ├─ canvas-overlay.tsx   # Draw/edit vertical separator lines
│  │  │  └─ pdf-preview-with-draw.tsx
│  │  ├─ md2xlsx/table-preview.tsx # Lazy table preview of parsed .md (IO-windowed rows)
│  │  ├─ layout/app-header.tsx   # Top bar (brand, tabs, language + theme toggles)
│  │  ├─ language-toggle.tsx     # English / 中文 dropdown
│  │  ├─ theme-toggle.tsx
│  │  └─ ui/                     # shadcn/ui components
│  ├─ i18n/
│  │  ├─ index.tsx               # LanguageProvider + useI18n() + t() interpolation
│  │  └─ translations.ts         # Typed en/zh dictionaries (TranslationKey)
│  ├─ lib/
│  │  ├─ ipc.ts                  # Tauri invoke() wrappers
│  │  ├─ types.ts                # Shared IPC DTO types
│  │  ├─ concurrency.ts          # Shared max-concurrent cache (default 1)
│  │  ├─ pdf-meta.ts             # PDF-type → badge/icon mapping
│  │  └─ utils.ts                # cn() helper
│  ├─ views/
│  │  ├─ pdf-to-md.tsx           # Batch queue + single-file PDF workspace
│  │  ├─ md-to-xlsx.tsx          # Markdown → Excel batch list + preview
│  │  └─ settings.tsx            # Sidebar settings (OCR service / Concurrent threads / Cache / Excel)
│  ├─ App.tsx                    # App shell, tab switching (PDF/MD → XLSX / settings)
│  ├─ index.css                  # Tailwind v4 + design tokens
│  └─ main.tsx                   # Entry, providers, imports index.css
├─ src-tauri/                    # Rust backend
│  ├─ src/
│  │  ├─ lib.rs                  # Tauri commands + run()
│  │  ├─ main.rs
│  │  ├─ models.rs               # Serialized DTOs (camelCase for the frontend)
│  │  └─ core/
│  │     ├─ convert.rs           # detect / convert / export wrappers
│  │     ├─ ocr.rs               # Hybrid (text+OCR) conversion, OCR HTTP client, local PaddleOCR engine
│  │     ├─ settings.rs          # OCR config + app settings persistence
│  │     ├─ secret.rs            # API key protection (DPAPI / obfuscation)
│  │     ├─ line_draw.rs         # Manual "draw-a-table" vertical-line extraction
│  │     ├─ md_to_xlsx.rs        # Markdown → Excel table parsing + export
│  │     ├─ grid_rebuild.rs      # Grid/region reconstruction from drawn lines
│  │     ├─ page_marker.rs       # `<!-- Page N -->` marker parsing + page attribution
│  │     └─ extract_cache.rs     # Per-document text extraction cache for draw-table
│  ├─ capabilities/default.json  # Permissions (dialog:open / save)
│  ├─ tauri.conf.json            # assetProtocol enabled for PDF preview
│  └─ Cargo.toml
├─ index.html
├─ package.json
└─ vite.config.ts
```

## IPC Contract

Commands (invoked from `src/lib/ipc.ts`):

| Command              | Input                                   | Output                       |
|----------------------|-----------------------------------------|------------------------------|
| `detect_pdf`         | `{ path }`                              | `DetectResult` (type, confidence, pages needing OCR, layout) |
| `convert_pdf`        | `{ path }`                              | `ConvertResult` (`DetectResult` + `markdown` + `processingTimeMs`) |
| `hybrid_session_start` | `{ path, ocrPages }` — 1-indexed pages needing OCR | `HybridSessionInfo` (sessionId + `ocrConfigured` + detect info; text pages extracted once and kept on the backend; no engine → OCR pages are skipped, not failed) |
| `hybrid_page_ocr`    | `{ sessionId, page, imagePng }` — one rendered page | `string` — that page's markdown (local PaddleOCR or remote AI; OCR failures degrade to a `<!-- OCR 失败 … -->` comment) |
| `hybrid_session_finish` | `{ sessionId }`                       | `ConvertResult` — text + OCR pages reassembled in document order; reports `skippedPages` and `failedPages` |
| `hybrid_session_abort` | `{ sessionId }`                      | `void` (discards an abandoned session) |
| `export_markdown`    | `{ path, content }`                     | `void` (writes markdown to file) |
| `get_ocr_config`     | —                                       | `OcrVendor[]` (keys never returned, only `apiKeySet`) |
| `save_ocr_config`    | `{ vendors }`                           | `void` (merges/encrypts API keys) |
| `reveal_ocr_key`     | `{ vendorId }`                          | `string \| null` (decrypted key, "show key") |
| `get_app_settings`   | —                                       | `AppSettings` (`maxConcurrent`, `cacheExtractedText`, `excelTablesOnly`, `ocrMode`) |
| `set_app_settings`   | `{ settings }`                          | `void` (clamped 1–16) |
| `analyze_markdown`   | `{ path }`                              | `MdAnalyzeResult` (`tableCount`, `tables[]` with columns/rows/page, `totalRows`, `processingTimeMs`) |
| `export_markdown_tables` | `{ mdPath, xlsxPath }`              | `MdExportResult` (`tableCount`, `totalRows`, `processingTimeMs`) |
| `extract_draw_table` | `{ path, drawData }` — `drawData` may carry `totalPages`, `onlyPages` (batching) and `pageImages[]` (`{page, imagePng, renderScale}`) for the mode-selected OCR fallback (local PaddleOCR or remote AI vision) | `DrawTableResult` (`tableCount`, `tables[]`, `regions[]`, `totalRows`, `ocrPages`, `emptyTextPages`, `processingTimeMs`) |
| `extract_draw_table_to_markdown` | `{ path, drawData, existingMarkdown? }` | `string` — merged markdown with extracted tables appended |

Result fields are serialized in camelCase; `PdfTypeDto` mirrors `pdf-inspector`'s
`PdfType` enum (`TextBased` / `Scanned` / `ImageBased` / `Mixed`).
`OcrMode` is a string union (`forceLocal` / `forceAi` / `nonTextLocal` /
`nonTextAi` / `disabled`).

## Rust ↔ Frontend Data Flow

```
[1] User drops / picks a PDF        → whole-window drag & drop or dialog plugin → absolute path
[2] detect_pdf(path)                → auto-runs on select → classification + OCR routing signals
[3] Convert (OCR disabled / nonText modes with no OCR needed)
    convert_pdf(path)               → pdf-inspector::process_pdf → full local Markdown
[4] Convert (OCR enabled — forceLocal / forceAi / nonTextLocal / nonTextAi)
    startHybridSession(path, N)     → backend extracts text pages once, resolves OCR engine;
                                       local PaddleOCR or remote AI vision provider;
                                       nonText modes also add any page whose local text
                                       extraction is empty (image-only pages); when no
                                       engine is available → pages are skipped and recorded
    renderPdfPagesForOcr(path, N)   → pdf.js renders ONE OCR page to PNG (base64) at a time
                                       (skipped entirely when local OCR is selected)
    hybrid_page_ocr(session, p, im) → local PaddleOCR or remote OCR provider, one page at a time
    hybrid_session_finish(session)  → reassemble in doc order; abort on cancel/error
[5] PDF preview                     → pdf.js fetches file via asset protocol → canvas pages
[6] Markdown preview / export       → paginated raw / rendered views (lazy per page), copy, save via dialog
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

- `src/i18n/translations.ts` — two dictionaries, `en` (default) and `zh`.
  The `TranslationKey` type is derived from the `en` keys, and `zh` is typed
  as `Record<TranslationKey, string>`, so adding a key to one language fails
  type-check until it exists in both.
- `src/i18n/index.tsx` — `LanguageProvider` + the `useI18n()` hook. It exposes
  `t(key, params?)` which interpolates `{param}` placeholders (e.g.
  `t("batch.completed", { done, total })`). The active language is persisted in
  `localStorage` (`doccraft-language`, default `en`).
- `src/components/language-toggle.tsx` — a dropdown button next to the theme
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

- **M1 (done)** — Scaffold (Tauri + React + shadcn), IPC, single-file local
  PDF → Markdown with editor-style preview workspace: whole-window drag & drop,
  auto-detect, pdf.js inline PDF preview (ScrollArea, dark mode), status bar.
- **M2 (done)** — OCR pipeline: sidebar settings page (OpenAI-compatible
  vendors / models / API keys + local PaddleOCR engine via `ocr-rs`), unified
  `OcrMode` selector (forceLocal / forceAi / nonTextLocal / nonTextAi /
  disabled), page rendering via pdf.js, hybrid conversion that routes text
  pages to pdf-inspector and scanned pages to the configured OCR engine,
  reassembled in document order.
- **M3 (mostly done)** — Batch processing: worker pool with a user-configurable
  concurrency limit (settings → Concurrent threads, default 1), retry / remove /
  export-all. (Live progress events & per-file OCR cancellation still optional.)
- **M3.5 (done)** — **Markdown → Excel**: batch `.md` analysis, auto table
  detection, table-by-table preview, and `.xlsx` export (single or all) with
  configurable **tables-only** mode. Plus manual **draw-a-table** extraction
  for scanned PDF regions (vertical-line-only mode, "apply to all pages" with
  page limit, page-filtered text extraction, extraction caching, and a local
  PaddleOCR fallback for pages without a text layer).
- **M4 (mostly done)** — Polish: **bilingual i18n (en/zh, runtime toggle)**
  and dark mode. **Large-document performance**: the Markdown preview and the
  Excel table preview both render lazily (page / table sections + windowed
  rows via IntersectionObserver, real-height placeholders), so big files no
  longer freeze the UI. **Settings page** restructured into a scrollable
  waterfall layout with four sections (OCR, Threads, Cache, Excel).
  (Config import/export and release packaging MSI/NSIS still planned.)

## Configuration

- `ocr-config.json` (per-vendor): name, base URL, protected API key
  (`v1:<DPAPI-encrypted hex>` on Windows, `obf:` fallback elsewhere),
  list of models (each with a `default` flag; a ★-marked model is the one used
  for OCR).
- `app-settings.json`: `maxConcurrent` (1–16, default 1) driving the batch
  worker-pool size, `cacheExtractedText` (default `true`) — when on, the
  line-draw table extraction decodes the current PDF's text once and reuses it
  across draw/merge calls; toggle it off for very large documents to free
  memory (the cache is evicted when another file is opened) —
  `excelTablesOnly` (default `true`) — when on, only GFM tables are exported
  to Excel; when off, the whole document content is written into the workbook
  — and `ocrMode` (default `disabled`), a unified OCR mode with five options:
  `forceLocal` (always local PaddleOCR), `forceAi` (always remote AI vision),
  `nonTextLocal` (local OCR only for pages without extracted text),
  `nonTextAi` (remote OCR only for pages without extracted text), and
  `disabled` (no OCR — pages needing OCR are skipped and never leave the
  machine). When OCR is enabled, conversion routes through the hybrid session
  and — in addition to the pages detection flagged — any page whose local text
  extraction produced no content is also sent to the OCR engine. The draw-table
  extraction shares the same mode selector: local modes (`forceLocal` /
  `nonTextLocal`) enable its on-device PaddleOCR fallback for scanned pages,
  AI modes (`forceAi` / `nonTextAi`) enable the remote vision fallback with
  drawn-line hints, and `disabled` keeps it text-layer-only.

Both live in the Tauri `app_config_dir` directory. No third-party store plugin
is required. For privacy, only pages that need OCR (detected or empty
extraction) are ever sent to an external OCR provider; local PaddleOCR mode
keeps all data on-device.

## License

MIT (project scaffold per `create-tauri-app`; `pdf-inspector` is MIT).