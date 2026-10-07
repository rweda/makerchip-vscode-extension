# Issues

A lightweight, in-repo backlog of deferred work. Preferred over external issue trackers here
because the backlog travels with the code, is greppable in-context, and can be opened/updated/closed
with plain file edits (AI-friendly).

## Convention

- One markdown file per issue, named `NNN-slug.md` (zero-padded id + short slug).
- Issue numbers (`NNN`) are not guaranteed unique due to parallel development in different clones.
- Start each file with a header block:
  ```
  # NNN: Title

  - Status: open | in-progress | wontfix
  - Area: <component/area>
  - Created: YYYY-MM-DD
  ```
- Then free-form body describing **current status and remaining work only** — an issue is a live
  backlog entry, not a changelog. Keep each file trimmed to what is true now and what is left to do.
- **Do not accumulate history in issues.** As work completes, remove it from the issue and fold any
  durable outcome into code, docs, and READMEs. Rely on Git history for the record of how an issue
  evolved — avoid dated "vN / shipped / verified on DATE" narration.
- Close an issue by deleting the file once nothing remains (or set `Status: wontfix` if abandoned),
  and add a dated entry to the **Closed** list below with its original `NNN-slug.md` filename — a
  trailhead into the Git history where the removed file (and its full evolution) lives.
- When you consciously defer a big or cross-cutting change, add an issue here rather than leaving a
  buried `TODO`, and reference it from related code (e.g. `// See issues/NNN-slug.md`).

## Index

- [001 — LM tool to open/restore a webview from the compile cache](001-restore-webview-from-compile-cache.md)
- [002 — Restore/waveform VCD parser rejects valid batch (non-monotonic) VCDs](002-vcd-parser-nonmonotonic-batch.md)
- [003 — Associate a compiled file with its Makerchip panel and reuse it](003-associate-file-with-makerchip-panel.md)
- [004 — Transfer programs/settings into the CE UI pane (in-place, no reload)](004-ce-ui-config-transfer.md)
- [005 — Headless CE-API compile path (no CE pane)](005-headless-ce-api-compile.md)
- [007 — Serve and announce compile include files](007-serve-announce-include-files.md)
- [009 — SystemVerilog language features inside TL-Verilog](009-sv-features-in-tlv.md)
- [010 — Agent one-shot tasks via a headless IDE Component](010-headless-components.md)
- [011 - Feedback from Yashvini](011-yashvini-feedback.md)
- [012 - An IDE call made while a panel is still connecting times out](012-ide-call-timeout-vs-panel-readiness.md)

## Closed

Trailheads into Git history for removed issue files. Recover full text with
`git log --follow -- issues/NNN-slug.md`.

- 2026-08-28 — `006-tool-gating-and-activation.md` (shipped: activation-graph engine, env holders,
  `makerchip_enable_tools`, `makerchip_invoke_tool`, and per-tool `when` gating on all 28 gated tools;
  Phase B pane-awareness dropped. Durable design now lives in `packages/makerchip-extension/src/toolActivation.ts`).
- 2026-09-28 — `008-invoke-tool-batched-calls.md` (shipped: `calls` array on `makerchip_invoke_tool`,
  run serially in-process so the harness sees one call and its one-per-round limit cannot hang;
  per-entry `fatal` (default true), `MAX_BATCH_CALLS`, per-call result headers preserving non-text parts. Rationale now
  lives in the BATCHING note on `InvokeToolTool` in `packages/makerchip-extension/src/makerchipTool.ts`).
