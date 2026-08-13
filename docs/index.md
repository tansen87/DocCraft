# DocCraft

A cross-platform **PDF → Markdown** desktop converter built with
[Tauri 2](https://tauri.app), React, TypeScript, [shadcn/ui](https://ui.shadcn.com) and
[`pdf-inspector`](https://crates.io/crates/pdf-inspector) (Firecrawl's pure-Rust PDF
classification / extraction engine).

> Chinese architecture design document: [docs/architecture.md](./architecture.md)

## Features

- **Hybrid text + OCR conversion** — text pages are extracted locally by
  `pdf-inspector`; pages that need OCR (scanned / image-only / undecodable
  fonts) are rendered to PNG and sent to a configured OCR provider. Per-page
  results are reassembled in document order, so page 1 & 3 (text) and page 2
  (scan) come out as 1 → 2 → 3.
- **Smart PDF routing** — `pdf-inspector` classifies each PDF (~10–50ms) as
  `TextBased` / `Scanned` / `ImageBased` / `Mixed` and reports exactly which
  pages need OCR (`pages_needing_ocr`). Pure-text PDFs never touch the network.
- **Local markdown extraction** — headings, lists, code blocks, tables, links,
  and repeated-header/footer stripping — no OCR needed for native text PDFs.
- **Configurable OCR providers** — any **OpenAI-chat-completions-compatible**
  vision API (`base_url`, per-vendor multiple models). API keys are encrypted
  at rest (DPAPI on Windows) and never sent back to the frontend. The first
  configured vendor with a key + model is used by default.
- **Batch queue with configurable concurrency** — multi-file drag & drop,
  worker-pool conversion, retry / remove / export-all, and a user-adjustable
  concurrency limit (1–16, default 1) persisted in app settings.
- **Editor-style workspace** — top toolbar (file name + convert action),
  split-view middle (PDF preview | Markdown preview) and a bottom status bar
  (PDF type, pages, confidence, OCR needs).
- **Whole-window drag & drop** — drop any PDF anywhere in the window; a drag
  overlay confirms the drop target; auto-detect runs immediately on select.
- **Sidebar settings page** — left navigation switches between **OCR 服务**
  (vendors / models / keys) and **并发线程** (batch conversion concurrency).

## Tech Stack

| Layer   | Choice |
|---------|--------|
| Desktop framework | Tauri 2.x (WebView + Rust core), asset protocol enabled for local file preview |
| Frontend          | React 19 + TypeScript + Vite 7 |
| UI kit            | shadcn/ui (Radix primitives, Tailwind CSS v4) |
| Package manager   | pnpm 10 |
| PDF engine        | `pdf-inspector` 1.14 (pure Rust, `lopdf`) |
| PDF preview / OCR images | `pdfjs-dist` 6.x (renders preview pages; also renders OCR pages to PNG for the backend) |
| HTTP client       | `reqwest` 0.12 (async, native-tls) |
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
│  │  ├─ convert/                # Convert workflow
│  │  │  ├─ convert-workspace.tsx# Workspace: detect → convert → preview
│  │  │  ├─ convert-toolbar.tsx  # Top toolbar (file info + convert CTA)
│  │  │  ├─ drop-zone.tsx        # Full-area pick / drag target (empty state)
│  │  │  ├─ drag-overlay.tsx     # Whole-window drag overlay
│  │  │  ├─ use-pdf-drop.ts      # Whole-window drag & drop hook
│  │  │  ├─ pdf-preview.tsx      # pdf.js inline preview (ScrollArea + dark mode)
│  │  │  ├─ preview-pane.tsx     # Markdown preview (render / raw toggle)
│  │  │  ├─ render-pdf-pages.ts  # Renders OCR pages to PNG base64 for the backend
│  │  │  └─ status-bar.tsx       # Bottom status (type / pages / confidence / OCR)
│  │  ├─ ui/                     # shadcn/ui components
│  │  ├─ layout/app-header.tsx   # Top bar (brand, tabs, theme toggle)
│  │  └─ theme-toggle.tsx
│  ├─ lib/
│  │  ├─ ipc.ts                  # Tauri invoke() wrappers
│  │  ├─ types.ts                # Shared IPC DTO types
│  │  ├─ concurrency.ts          # Shared max-concurrent cache (default 1)
│  │  ├─ pdf-meta.ts             # PDF-type → label/icon/badge mapping
│  │  └─ utils.ts                # cn() helper
│  ├─ views/
│  │  ├─ convert.tsx             # Batch list + single-file workspace routing
│  │  └─ settings.tsx            # Sidebar settings (OCR 服务 / 并发线程)
│  ├─ App.tsx                    # App shell, tab switching (batch / settings)
│  ├─ index.css                  # Tailwind v4 + design tokens
│  └─ main.tsx                   # Entry, imports index.css
├─ src-tauri/                    # Rust backend
│  ├─ src/
│  │  ├─ lib.rs                  # Tauri commands + run()
│  │  ├─ main.rs
│  │  ├─ models.rs               # Serialized DTOs (camelCase for the frontend)
│  │  └─ core/
│  │     ├─ convert.rs           # detect / convert / export wrappers
│  │     ├─ ocr.rs               # Hybrid (text+OCR) conversion, OCR HTTP client
│  │     ├─ settings.rs          # OCR config + app settings persistence
│  │     └─ secret.rs            # API key protection (DPAPI / obfuscation)
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
| `hybrid_session_start` | `{ path, ocrPages }` — 1-indexed pages needing OCR | `HybridSessionInfo` (sessionId + detect info; text pages extracted once and kept on the backend) |
| `hybrid_page_ocr`    | `{ sessionId, page, imagePng }` — one rendered page | `string` — that page's markdown (OCR failures degrade to a `<!-- OCR 失败 … -->` comment) |
| `hybrid_session_finish` | `{ sessionId }`                       | `ConvertResult` — text + OCR pages reassembled in document order |
| `hybrid_session_abort` | `{ sessionId }`                      | `void` (discards an abandoned session) |
| `export_markdown`    | `{ path, content }`                     | `void` (writes markdown to file) |
| `get_ocr_config`     | —                                       | `OcrVendor[]` (keys never returned, only `apiKeySet`) |
| `save_ocr_config`    | `{ vendors }`                           | `void` (merges/encrypts API keys) |
| `reveal_ocr_key`     | `{ vendorId }`                          | `string \| null` (decrypted key, "show key") |
| `get_app_settings`   | —                                       | `AppSettings` (`maxConcurrent`) |
| `set_app_settings`   | `{ settings }`                          | `void` (clamped 1–16) |

Result fields are serialized in camelCase; `PdfTypeDto` mirrors `pdf-inspector`'s
`PdfType` enum (`TextBased` / `Scanned` / `ImageBased` / `Mixed`).

## Rust ↔ Frontend Data Flow

```
[1] User drops / picks a PDF        → whole-window drag & drop or dialog plugin → absolute path
[2] detect_pdf(path)                → auto-runs on select → classification + OCR routing signals
[3] Convert (pure text PDF)
    convert_pdf(path)               → pdf-inspector::process_pdf → full local Markdown
[4] Convert (mixed / scanned PDF)
    startHybridSession(path, N)     → backend extracts text pages once, resolves OCR provider
    renderPdfPagesForOcr(path, N)   → pdf.js renders ONE OCR page to PNG (base64) at a time
    hybrid_page_ocr(session, p, im) → OCR provider per image, streamed one page at a time
    hybrid_session_finish(session)  → reassemble in doc order; abort on cancel/error
[5] PDF preview                     → pdf.js fetches file via asset protocol → canvas pages
[6] Markdown preview / export       → raw / rendered views, copy, save via dialog
```

`hybrid_page_ocr` runs async so OCR HTTP calls never block the UI, and pages
are streamed one at a time so peak memory stays at a single page image instead
of the whole document. API keys are decrypted only inside the Rust process
(`core::settings::api_key_for`) and sent as `Authorization: Bearer`; the
frontend never sees them. Sessions are auto-pruned if the frontend never
finishes or aborts them.
Errors from `PdfError` are stringified and surfaced through toast notifications.

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
  vendors / models / API keys), page rendering via pdf.js, hybrid conversion
  that routes text pages to pdf-inspector and scanned pages to the OCR
  provider, reassembled in document order.
- **M3 (mostly done)** — Batch processing: worker pool with a user-configurable
  concurrency limit (settings → 并发线程, default 1), retry / remove /
  export-all. (Live progress events & per-file OCR cancellation still optional.)
- **M4 (planned)** — Polish: error details, markdown rendering preview
  enhancements, config import/export, release packaging (MSI/NSIS).

## Configuration

- `ocr-config.json` (per-vendor): name, base URL, protected API key
  (`v1:<DPAPI-encrypted hex>` on Windows, `obf:` fallback elsewhere),
  list of models.
- `app-settings.json`: `maxConcurrent` (1–16, default 1) driving the batch
  worker-pool size.

Both live in the Tauri `app_config_dir` directory. No third-party store plugin
is required. For privacy, only pages flagged as needing OCR are ever sent to an
external OCR provider.

## License

MIT (project scaffold per `create-tauri-app`; `pdf-inspector` is MIT).