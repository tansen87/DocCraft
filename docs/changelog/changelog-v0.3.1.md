# DocCraft Changelog

All notable changes to DocCraft are documented in this folder. The format is
based on [Keep a Changelog](https://keepachangelog.com/), and this project
adheres to [Semantic Versioning](https://semver.org/).

DocCraft is a cross-platform **PDF → Markdown** and **Markdown → Excel**
desktop converter built with Tauri 2, React, TypeScript and
[`pdf-inspector`](https://crates.io/crates/pdf-inspector).

---

## [0.3.1] - 2026-10-18

This release rebuilds the **Settings page** around a grouped, text-only
navigation and one card per section with a per-field save bar, and fixes the
manual **update check** so it can no longer report "up to date" while the
startup check is still running (which is exactly when an available update shows
up seconds later). It also refreshes the Rust and JS dependencies.

### Added

- **Settings search & section picker** — a filter box at the top of the sidebar
  (`Ctrl K` focuses it) narrows the visible settings as you type; below 768 px
  the sidebar gives way to a **section picker** dropdown instead of collapsing
  into an icon rail.
- **Per-field unsaved count** — the save bar reports **how many** settings are
  pending (hovering the count lists them by their row titles) instead of a
  single "unsaved changes" flag, so `N` is a real number rather than a blanket
  prompt.
- **Download progress ring** — the header update button draws a determinate ring
  around the icon while a release is downloading (only when the server reported
  a total size) and a spinner otherwise; the tooltip now reflects the live check
  / download state.
- **OCR section sub-headings** — "Recognition engine", "Layout analysis",
  "Providers & keys" and "Custom prompts" split the longest section into
  scannable parts.

### Changed

- **Settings layout** — the 12 flat navigation items became four **text-only
  groups** (Recognition / Conversion / Appearance / Data & about); each section
  is now **one card** with a sticky head (title plus a one-line hint) and
  hairline-separated rows, replacing the stack of independent panels. The
  redundant in-content "Settings" page header was removed, the scroll-sync moved
  to an `IntersectionObserver` (the hand-tuned reference line, `pinnedRef` and
  tail spacer are gone), and the responsive icon-rail branch was dropped.
  `state` / save flow / IPC are unchanged; design doc
  [00002](../design/00002_settings-ui-redesign.md) records the revision.
- **Save bar** — moved out of the floating overlay to its own row **below** the
  scroll area (with `Discard` / `Save`), so it no longer covers the last section
  or sits against the window close button; it also no longer disappears when
  nothing is dirty, showing "All changes saved" instead.
- **Manual update check** — a forced check that lands while the startup check is
  in flight now polls `get_update_state` until the phase settles (up to 15 s)
  before reporting, and a **skipped** release is reported as such (with the
  version) rather than as "up to date". The header button shows motion
  (progress ring or spinner) instead of a dimmed, dead face while it works.
- **Update entry icon** — the header update button now uses a `cloud-download`
  icon, and the duplicate Settings icon next to the update entry was removed.
- **Release notes** — `.github/workflows/release.yml` now feeds **only this
  release's changelog section** to `latest.json` / the in-app update dialog, by
  stripping everything above the first `## [...]` heading (the file preamble).
- **Dependencies** — `sha2` `0.10 → 0.11`, `reqwest` `0.13.4 → 0.13`,
  `pdf-inspector` `1.20.0 → 1.25.2` (the new text-element fields are wired
  through the test fixtures); the Tauri Rust crates and the `@tauri-apps/*` JS
  packages are pinned to `^2` / their resolved versions for reproducible builds.

### Fixed

- A manual update check could **wrongly report "up to date"**: the backend
  single-flights checks, so clicking while the startup check was running handed
  back that check's transient snapshot (no version yet) - which the UI read as
  "no update", while the running check then found one seconds later. The button
  now waits for the in-flight check to settle first.
- `sha2` 0.11's `finalize()` returns a `hybrid_array::Array` that no longer
  implements `LowerHex` (0.10's `GenericArray` did), so model-file SHA-256
  digests are now hex-encoded locally, keeping download / import verification
  working against the pinned lowercase digests.

### Removed

- Design-doc number references and non-ASCII decoration from `src` / `src-tauri`
  comments (the docs remain the source of truth; the code just stops repeating
  `(00015 §2.3)` and box-drawing characters).
- The in-content Settings page header and the settings sidebar's icon rail.
