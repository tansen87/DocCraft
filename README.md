# DocCraft

A cross-platform **PDF → Markdown**, **Image → Markdown**, and **Markdown → Excel**
desktop converter built with [Tauri 2](https://tauri.app), React, TypeScript,
[shadcn/ui](https://ui.shadcn.com) and
[`pdf-inspector`](https://crates.io/crates/pdf-inspector) (Firecrawl's pure-Rust
PDF classification / extraction engine). The UI is bilingual — English (default)
and Simplified Chinese — switchable at runtime.

> Detailed architecture & data-flow docs: [docs/index.md](./docs/index.md)

## Screenshots
![pdf2md](./docs/img/pdf2md_draw-table.jpg)

![image2md](./docs/img/image2md.jpg)

![md2excel](./docs/img/md2excel.jpg)

![settings](./docs/img/settings.jpg)

## Features

### PDF → Markdown
- **Hybrid text + OCR** — text pages extracted locally by `pdf-inspector`; scanned
  / image-only pages rendered to PNG and sent to a configured OCR provider (remote
  AI vision or local PaddleOCR), then reassembled in document order.
- **Smart PDF routing** — each PDF is classified (~10–50ms) as `TextBased` /
  `Scanned` / `ImageBased` / `Mixed` with the exact list of pages needing OCR.
  Pure-text PDFs never touch the network.
- **Configurable OCR providers** — any OpenAI-chat-completions-compatible vision
  API (multiple vendors, multiple models per vendor) or the built-in local
  PaddleOCR engine. API keys are encrypted at rest (DPAPI on Windows) and never
  exposed to the frontend. A unified **OCR mode** selector offers five options:
  `ForceLocal`, `ForceAi`, `NonTextLocal`, `NonTextAi`, `Disabled`.
- **Graceful OCR fallback** — when no OCR provider is available, conversion
  still completes: pages needing OCR are skipped with `<!-- OCR skipped -->`
  comments. Per-page failures degrade to `<!-- OCR failed -->` comments. A bell
  icon in the status bar collects these as structured notices with clickable
  page chips and retry actions.
- **Draw-a-table extraction** — manually draw vertical separators over a
  rendered PDF page to define table regions, then extract them into Markdown.
  Supports undo/redo, per-page lines, "apply to all pages" mode, and OCR
  fallback for scanned pages (local PaddleOCR or remote AI vision with drawn-line
  hints).
- **Batch queue** — drag & drop many PDFs, worker-pool conversion with a
  user-configurable concurrency limit (1–16), retry / remove / export-all.
- **Editor workspace** — toolbar (convert), split view (PDF preview | Markdown
  preview), status bar (type / pages / confidence / OCR needs / notices bell).

### Image → Markdown
- Dedicated workspace tab accepting PNG / JPEG images via drag & drop or file
  picker, with deduplicated list and thumbnails.
- Each image is recognized by the OCR engine selected by the current **OCR mode**
  (local PaddleOCR or remote AI vision).
- Results are previewed as a merged GFM document and can be exported per-image
  or merged into a single `.md` file.
- **Draw-table on images** — imported images can be opened in a draw-table
  overlay where you draw vertical lines, then the image + line positions are
  sent to the backend for column-based extraction (local PaddleOCR text blocks
  + column cutting, or AI vision with line hints, depending on the OCR mode).

### Markdown → Excel
- Drop or pick `.md` files; each is parsed for GitHub-Flavored Markdown tables.
- Inline table preview with table/row counts, single or bulk export to `.xlsx`.
- Configurable **tables-only** mode: exports only GFM tables; when off, the
  whole document content is written into the workbook.
- Each table is labeled with its source PDF page (`Page N`) when produced by
  this app's PDF conversion.

### Performance & memory
- **Per-page OCR streaming** — the frontend renders and uploads one page at a
  time; peak memory stays at a single page image instead of the whole document.
- **Virtualized PDF preview** — only pages near the scroll viewport are rendered
  to canvas; off-screen bitmaps are released.
- **Lazy Markdown / Excel preview** — paginated rendering and windowed rows for
  large documents.
- **State-preserving tabs** — switching between tabs keeps every view mounted
  (hidden, not unmounted), so loaded files, results and queues survive tab switches.

### System tray
- System tray icon with right-click menu (Open, Start Screenshot, Exit) and
  left-click to show the main window. Close button hides to tray instead of
  quitting. Configurable in Settings.

## Tech Stack

| Layer | Choice |
|-------|--------|
| Desktop framework | Tauri 2.x (WebView + Rust core) |
| Frontend | React 19 + TypeScript + Vite 8 |
| UI kit | shadcn/ui (Radix primitives, Tailwind CSS v4) |
| Package manager | pnpm 10 |
| PDF engine | `pdf-inspector` 1.17 (pure Rust, `lopdf`) |
| Local OCR engine | `ocr-rs` 2.4 (PaddleOCR, pure Rust) |
| PDF rendering | `pdfjs-dist` 6.x (preview + OCR page PNGs) |
| Markdown / Excel | `react-markdown` + GFM on frontend; `rust_xlsxwriter` on backend |
| i18n | custom lightweight React Context (typed en/zh dictionaries) |
| HTTP client | `reqwest` 0.13 (async, native-tls) |
| Secret storage | DPAPI via `windows-sys` on Windows |
| Config storage | JSON files in Tauri `app_config_dir` |

## Project Structure

```
doccraft/
├─ docs/
│  └─ index.md                   # Full architecture & data-flow documentation
├─ src/                          # React frontend
│  ├─ components/
│  │  ├─ pdf2md/                 # PDF → Markdown workflow
│  │  ├─ draw-table/             # Manual "draw-a-table" extraction
│  │  ├─ image-table/            # Image draw-table overlay
│  │  ├─ snip/                   # Screenshot overlay
│  │  ├─ md2xlsx/                # Markdown → Excel preview
│  │  ├─ layout/                 # App header (tabs, language, theme)
│  │  └─ ui/                     # shadcn/ui components
│  ├─ i18n/                      # Language provider + typed en/zh dictionaries
│  ├─ lib/                       # IPC wrappers, types, utilities
│  ├─ views/                     # Page-level components (pdf-to-md, image-to-md, md-to-xlsx, settings)
│  ├─ App.tsx                    # App shell, tab switching
│  ├─ index.css                  # Tailwind v4 + design tokens
│  └─ main.tsx                   # Entry point
├─ src-tauri/                    # Rust backend
│  ├─ src/
│  │  ├─ lib.rs                  # Tauri commands + run()
│  │  ├─ main.rs
│  │  ├─ models.rs               # Serialized DTOs (camelCase)
│  │  └─ core/                   # convert, ocr, settings, secret, line_draw, md_to_xlsx, snip, ...
│  ├─ capabilities/              # Permissions
│  ├─ tauri.conf.json
│  └─ Cargo.toml
├─ index.html
├─ package.json
└─ vite.config.ts
```

## Getting Started

Prerequisites: Node ≥ 20, pnpm ≥ 10, Rust ≥ 1.85.

```bash
pnpm install       # install frontend deps
pnpm tauri dev     # run the desktop app (HMR + debug build)
```

Useful checks:

```bash
pnpm exec tsc --noEmit               # frontend type check
pnpm build                           # frontend production build
cargo check --manifest-path src-tauri/Cargo.toml
```

## Configuration

- `ocr-config.json` — per-vendor name, base URL, protected API key, models.
- `app-settings.json` — `maxConcurrent`, `cacheExtractedText`, `excelTablesOnly`,
  `ocrMode`, `screenshotHotkey`, `enableTray`, `textSeparator`.

Both live in the Tauri `app_config_dir`. For privacy, only pages flagged as
needing OCR are ever sent to an external provider; local PaddleOCR mode keeps
all data on-device. OCR sessions are auto-pruned if never finished.

## License

MIT