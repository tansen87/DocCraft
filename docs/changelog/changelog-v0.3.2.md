# DocCraft Changelog

All notable changes to DocCraft are documented in this folder. The format is
based on [Keep a Changelog](https://keepachangelog.com/), and this project
adheres to [Semantic Versioning](https://semver.org/).

DocCraft is a cross-platform **PDF → Markdown** and **Markdown → Excel**
desktop converter built with Tauri 2, React, TypeScript and
[`pdf-inspector`](https://crates.io/crates/pdf-inspector).

---

## [0.3.2] - 2026-10-19

This release turns the **Settings filter** into a real settings search - it now
matches the settings' own text instead of just the section titles - and returns
the sidebar to a single flat list. It also fixes a Windows installer bug that
slipped an extra `DocCraft` folder into the install path on every install and
update.

### Added

- **Row-level settings search** — the sidebar filter now matches the settings
  themselves: every row's label and description, plus the value **currently
  shown inside** its control (the selected OCR mode, the paragraph mode in
  effect, a hotkey, ...). A row description word like `accelerate` or
  `zero-width`, or the option a control is currently set to, therefore finds the
  row it belongs to - in either language. Results are listed as `card › row`
  (indented under the card title); when a row matched on its description, that
  description is shown as a second grey line, so "why is this here?" is answered
  without opening the card. Clicking a card title jumps to the top of that card,
  clicking a row parks it just below the sticky card head and highlights it for
  1.6 s. The index is read off the rendered cards, so live values and both
  languages are covered without a second dictionary - design doc
  [00002](../design/00002_settings-ui-redesign.md) records the revision.

### Changed

- **Settings sidebar is flat again** — the eleven sections are one text-only
  list in card order, and the four group headings introduced in 0.3.1
  (Recognition / Conversion / Appearance / Data & about) plus their translation
  keys are gone.
- **Sidebar scrolling** — the sidebar lists (navigation and search results) now
  use the same `ScrollArea` as the cards column, so both show the same thin
  scrollbar instead of the WebView's own. The jump/highlight scrolling is
  re-scoped to the cards column, since the sidebar's scroll viewport is now the
  first one in the page and would otherwise be picked up by accident.

### Fixed

- **The installer nested the app in an extra `DocCraft` folder** — the NSIS
  pre-install hook normalises `$INSTDIR` with `StrCpy`, but passed `-9` as the
  *max length* (third parameter) instead of the *start offset* (fourth). The
  copy therefore truncated the last nine characters instead of extracting the
  trailing `\DocCraft`, the suffix check never matched, and every install and
  update appended another `\DocCraft` level (`<chosen>\DocCraft\DocCraft`). The
  call now passes an empty max length plus the negative start offset, and the
  example in design doc
  [00020](../design/00020_update-check-and-install-layout.md) was corrected.
  Installations that are already nested keep updating in place; nothing moves
  them back to the parent folder.
