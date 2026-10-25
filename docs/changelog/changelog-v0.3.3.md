# DocCraft Changelog

All notable changes to DocCraft are documented in this folder. The format is
based on [Keep a Changelog](https://keepachangelog.com/), and this project
adheres to [Semantic Versioning](https://semver.org/).

DocCraft is a cross-platform **PDF → Markdown** and **Markdown → Excel**
desktop converter built with Tauri 2, React, TypeScript and
[`pdf-inspector`](https://crates.io/crates/pdf-inspector).

---

## [0.3.3] - 2026-10-25

This release hardens the **draw-a-table** surface: deleting something you drew
no longer happens on an accidental double-click, and a picked merge column
stays on the same part of the page while separators are added, removed or
dragged.

### Changed

- **Right-click to delete on the drawing surface** — vertical separators, row
  boundaries and exclusion rectangles are no longer removed by a left
  double-click (too easy to trigger while placing or adjusting lines); a right
  click deletes them instead. Only the left button draws, drags and resizes,
  and `Delete` / `Backspace` still removes the selected exclusion rectangle.
  The toolbar hints were updated in both languages.
- **Merge columns: left-click adds, right-click removes** — in guided
  paragraph mode a left click still picks a column whose wrapped lines merge,
  while a right click now clears that pick; previously the left click toggled
  both ways. The merge tool's hint and tooltip follow the new interaction.

### Fixed

- **The merge highlight jumped after the separators changed** — picked merge
  columns were stored as positional indices, so inserting, removing or dragging
  a vertical separator shifted every column to its right and a stored index
  could highlight a completely different region (even when the new line was
  drawn elsewhere). Each pick is now re-derived from the merged column's own
  left boundary - or, when that boundary is gone, from the new column still
  covering the region's centre - so the green highlight stays on the same part
  of the page. Extraction uses the same remapped indices, keeping the
  guided-merge result aligned with what is shown.
