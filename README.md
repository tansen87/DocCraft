# DocCraft

- **PDF → Markdown** — hybrid local text extraction + OCR for scanned pages
- **Markdown → Excel** — parse GFM tables and export them to `.xlsx`
- Low-memory by design: PDF preview is virtualized, and OCR pages are streamed one at a time instead of loading the whole document into memory.

> Detailed architecture & data-flow docs: [docs/index.md](./docs/index.md)

## Features

### PDF → Markdown
- **Hybrid text + OCR** — text pages are extracted locally by [`pdf-inspector`](https://crates.io/crates/pdf-inspector) (Firecrawl's pure-Rust PDF engine); scanned/image/undecodable pages are rendered to PNG and sent to a configured OCR provider, then reassembled in document order.
- **Smart routing** — each PDF is classified (`TextBased` / `Scanned` / `ImageBased` / `Mixed`) in ~10–50ms with the exact list of pages needing OCR. Pure-text PDFs never touch the network.
- **Local extraction** — headings, lists, code blocks, tables, links and repeated header/footer stripping for native text PDFs.
- **Configurable OCR providers** — any OpenAI-chat-completions-compatible vision API (`base_url` + multiple models per vendor). API keys are encrypted at rest (DPAPI on Windows) and never exposed to the frontend.
- **Batch queue** — drag & drop many PDFs, worker-pool conversion with a user-configurable concurrency limit (1–16), retry / remove / export-all.
- **Editor workspace** — toolbar (convert), split view (PDF preview | Markdown preview), and a status bar (type / pages / confidence / OCR needs).

### Markdown → Excel
- Drop or pick `.md` files; each is parsed for GitHub-Flavored Markdown tables.
- Inline table preview with table/row counts, single or bulk export to `.xlsx`.

### Performance & memory
- **Per-page OCR streaming** — the frontend renders and uploads one page at a time via a backend session (`hybrid_session_start` → `hybrid_page_ocr` → `hybrid_session_finish`); peak memory stays at a single page image instead of the whole document's base64 payloads.
- **Virtualized PDF preview** — only pages near the scroll viewport are rendered to canvas; off-screen bitmaps are released (backed by IntersectionObserver + ResizeObserver).
- **State-preserving tabs** — switching between PDF→MD / MD→Excel / Settings keeps every view mounted (hidden, not unmounted), so loaded files, results and queues survive tab switches.

## Tech Stack

| Layer            | Choice |
|------------------|--------|
| Desktop framework | Tauri 2.x (WebView + Rust core) |
| Frontend         | React 19 + TypeScript + Vite 8 |
| UI kit           | shadcn/ui (Radix primitives, Tailwind CSS v4) |
| Package manager  | pnpm 10 |
| PDF engine       | `pdf-inspector` 1.14 (pure Rust, `lopdf`) |
| PDF rendering    | `pdfjs-dist` 6.x (preview + OCR page PNGs) |
| Markdown preview | `react-markdown` + `remark-gfm` + `rehype-highlight` |
| xlsx export      | Rust-side (`analyze_markdown` / `export_markdown_tables`) |
| HTTP client      | `reqwest` (async, native-tls) |
| Secret storage   | DPAPI via `windows-sys` on Windows |
| Config storage   | JSON in Tauri `app_config_dir` |

## Getting Started

Prerequisites: Node ≥ 20, pnpm ≥ 10, Rust ≥ 1.85.

```bash
pnpm install       # install frontend deps
pnpm tauri dev     # run the desktop app (HMR + debug build)
```

Useful checks:

```bash
pnpm exec tsc --noEmit               # frontend type check
pnpm build                          # frontend production build
cargo check --manifest-path src-tauri/Cargo.toml
```

## Configuration

- `ocr-config.json` — per-vendor name, base URL, protected API key (`v1:<DPAPI-encrypted hex>` on Windows, `obf:` fallback elsewhere), models.
- `app-settings.json` — `maxConcurrent` (1–16, default 1).

Both live in the Tauri `app_config_dir`. For privacy, only pages flagged as needing OCR are ever sent to an external provider; OCR sessions are auto pruned if never finished.

## License

MIT