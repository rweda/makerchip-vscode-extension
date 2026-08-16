# Issues

A lightweight, in-repo backlog of deferred work. Preferred over external issue trackers here
because the backlog travels with the code, is greppable in-context, and can be opened/updated/closed
with plain file edits (AI-friendly).

## Convention

- One markdown file per issue, named `NNN-slug.md` (zero-padded id + short slug).
- Start each file with a header block:
  ```
  # NNN: Title

  - Status: open | in-progress | done | wontfix
  - Area: <component/area>
  - Created: YYYY-MM-DD
  ```
- Then free-form body (Problem / Options / Recommendation / Notes as useful).
- Close an issue by setting `Status: done` (keep the file for history) or deleting it.
- When you consciously defer a big or cross-cutting change, add an issue here rather than leaving a
  buried `TODO`, and reference it from related code (e.g. `// See issues/NNN-slug.md`).

## Index

- [001 — LM tool to open/restore a webview from the compile cache](001-restore-webview-from-compile-cache.md)
- [002 — Restore/waveform VCD parser rejects valid batch (non-monotonic) VCDs](002-vcd-parser-nonmonotonic-batch.md)
- [003 — Associate a compiled file with its Makerchip panel and reuse it](003-associate-file-with-makerchip-panel.md)
