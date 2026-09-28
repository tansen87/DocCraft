# DocCraft Changelog

All notable changes to DocCraft are documented in this folder. The format is
based on [Keep a Changelog](https://keepachangelog.com/), and this project
adheres to [Semantic Versioning](https://semver.org/).

DocCraft is a cross-platform **PDF → Markdown** and **Markdown → Excel**
desktop converter built with Tauri 2, React, TypeScript and
[`pdf-inspector`](https://crates.io/crates/pdf-inspector).

---

## [0.3.0] - 2026-09-28

This release makes DocCraft **self-updating** and stops shipping models inside
the installer: updates are now downloaded, signature-verified and installed from
inside the app, the NSIS installer always targets a dedicated folder without
needing administrator rights, and OCR/layout models are fetched on demand (or
dragged in) instead of being bundled.

### Added

- **One-click auto-update** — `core/update.rs` drives the official
  `tauri-plugin-updater` from Rust (the webview is granted no `updater:*`
  permission). A check runs once per session, ~3s after launch, off the render
  path; an available release shows a small **green dot** on the header button.
  Clicking it downloads the installer, verifies it against the bundled minisign
  public key and installs it (`passive`, per-user, no UAC), then the app
  restarts itself and announces "updated to vX.Y.Z" once. Update source is
  GitHub only; the Gitee links were removed. Includes per-version *skip*,
  an `autoCheckUpdate` setting and a manual check.
- **Model downloads & local import** — models are no longer bundled (installer
  ~21MB → **6MB**). The new **Settings → Models** section lists every group
  (OCR tiny / small / medium and the layout model) with its size and installed
  state; each group is fetched from ModelScope with **size + SHA-256
  verification** before it is put in place, and files you already have can be
  dropped in or picked (recognised by name, verified the same way, only copied).
  Progress is reported over `models://progress`.
- **Signed release pipeline** — `.github/workflows/release.yml` builds, signs
  and publishes the installer plus `latest.json` on a `v*` tag (draft release,
  published manually); the workflow fails when the tag disagrees with the
  bundled version and uses `docs/changelog/changelog-<tag>.md` as the release
  notes (so the in-app update dialog shows them).
- **Design docs** `00020` (update check & installer layout), `00021`
  (auto-download/install, incl. a symptom → cause troubleshooting table) and
  `00022` (model downloads).

### Changed

- **Installer layout** — NSIS `installMode: currentUser` (no administrator
  rights) and, through `windows/installer-hooks.nsh`, every install lands in a
  dedicated `<chosen path>\DocCraft` folder (idempotent, system locations are
  refused with an explanation before anything is copied).
- **Resource layout flattened** — the `doccraft_resources/` wrapper directory is
  gone: models live in `<install dir>\models` and runtime data (settings, the
  DPAPI-encrypted keys, the usage log) in `<install dir>\data`, all next to the
  executable. `core/migrate.rs` moves a legacy `doccraft_resources/` tree over on
  the first launch (additive only - nothing is overwritten or deleted).
- **Update-check failures are actionable** — a missing update manifest
  (`releases/latest/download/latest.json` 404, e.g. a draft-only release) is
  reported as a localised "no update channel yet" message instead of the
  plugin's raw text; network failures are classified separately.

### Fixed

- Update checks no longer run on the frontend render path (they were triggered
  when the header mounted); they are scheduled from Rust instead.
- ModelScope downloads send a `User-Agent` (its CDN answers `403` to requests
  without one, which made every model download fail).

### Removed

- Bundled OCR model tiers from the installer, the Gitee links in the update
  dialog, and the layout-model download hint (plus its ModelScope link) in
  Settings - downloads now have a single entry point under **Models**.
- The `msi` build target (`targets` is now `["nsis"]`).
