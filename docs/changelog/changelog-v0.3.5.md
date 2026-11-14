# DocCraft Changelog

All notable changes to DocCraft are documented in this folder. The format is
based on [Keep a Changelog](https://keepachangelog.com/), and this project
adheres to [Semantic Versioning](https://semver.org/).

DocCraft is a cross-platform **PDF → Markdown** and **Markdown → Excel**
desktop converter built with Tauri 2, React, TypeScript and
[`pdf-inspector`](https://crates.io/crates/pdf-inspector).

---

## [0.3.5] - 2026-11-14

A UI release: the window finally says what it is, and the settings page stops
stacking translucent cards inside a translucent window. Nothing about
conversion, OCR or model handling changed.

### Added

- **Product wordmark in the title bar** — `DocCraft` now sits at the left edge
  of the custom title bar (13px / 600, foreground ink, 12px from the window
  edge, 16px to the tab strip). The brand block is part of the drag region, so
  the whole left end of the bar moves the window; `src/components/wordmark.tsx`
  is shared with the screenshot result popup, which had been using its own
  12px / tracked / muted copy of the name - the quietest line on that window.
- **Quiet hover affordance on the bar** — hovering the title bar tints it by 7%
  of the foreground colour (darker in the light theme, lighter in the dark one),
  so it reads as a draggable strip without a colour jump.
- **Unsaved-changes dots in the settings sidebar** — an entry whose section holds
  pending edits gets a 6px square marker, so you no longer have to scroll the
  page looking for the row you changed.

### Changed

- **Settings page rebuilt around a flatter surface** — cards are a solid surface
  with one hairline and a 12px radius (was `bg-card/80` + `backdrop-blur-sm` +
  `shadow-sm` + 16px radius, i.e. glass stacked on glass). Depth now comes from
  the surface step, not from shadows.
- **Card heads are one line** — section title and its summary share a 40px band
  (was two stacked lines, 56px), so a screen holds noticeably more settings.
- **Model files read as spec rows** — square status light, name, one-word tier
  note, size and file count in a right-aligned monospace column, action in a
  fixed column. The raw file names are gone from the page; the models directory
  is printed once, in the import row, which is now a single line instead of a
  dashed drop box taller than the rows above it.
- **Usage statistics became a readout** — one 4-row × 3-column table (files,
  pages, OCR pages, total time × today / this month / all time) with monospace
  right-aligned figures and the PDF/image and local/AI splits kept underneath,
  replacing three stacked period blocks that ran past a screen.
- **The save bar is a footer** — flush with the content column, one hairline
  above it and a solid surface behind it, instead of a floating card that
  covered the last rows. It still shows the pending count (hover lists them) and
  keeps its secondary buttons.
- **Provider entries are flat rows** — the collapsible vendor block lost its
  nested card box and its unlabelled `2` badge; name, monospace base URL, model
  count and the "key saved" state sit on one line, editing still expands in
  place.
- **Chinese copy** — the settings strings now use full-width punctuation, and
  tier labels read `tiny — 更快` / `small — 均衡` / `medium — 最准` instead of
  `tiny(更快)`.
- **All settings actions use the secondary button** — the one `outline` button
  (clear skipped version) was brought in line; icon-only buttons stay ghost.

### Fixed

- **The scroll bar no longer covers the settings content** — on Windows 11 the
  WebView2 scrollbar is an overlay that paints over the last ~16px of the
  viewport, so the cards' right border sat under it. The content column now
  reserves a 24px gutter (the sidebar list 16px, for the same reason and for its
  unsaved dot), and the footer buttons line up with the card edge again.

### Removed

- The green hover wash on both title bars (`hover:bg-green-500/15`). Green is a
  semantic colour in this app; using it as chrome feedback said nothing.

