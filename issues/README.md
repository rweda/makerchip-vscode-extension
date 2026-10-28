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
- The **Index** below lists each issue as `- [<title line without "# ">](NNN-slug.md)`, with the link
  text a verbatim copy of the file's title. Use only typable characters (`--`, not an em dash).
- Close an issue by deleting the file once nothing remains (or set `Status: wontfix` if abandoned),
  and move its Index line to the top of **Closed**, optionally followed by an indented line with the
  close date and details. Point the link at the file's last version, where `<commit>` is the
  (pushed) `HEAD` you are deleting it from (`git rev-parse --short HEAD`):
  `https://github.com/rweda/makerchip-vscode-extension/blob/<commit>/issues/NNN-slug.md`.
- When you consciously defer a big or cross-cutting change, add an issue here rather than leaving a
  buried `TODO`, and reference it from related code (e.g. `// See issues/NNN-slug.md`).

## Index

- [001: LM tool to open/restore a webview from the compile cache](001-restore-webview-from-compile-cache.md)
- [003: Associate a compiled file with its Makerchip panel and reuse it](003-associate-file-with-makerchip-panel.md)
- [004: Transfer programs/settings into the CE UI pane (in-place, no reload)](004-ce-ui-config-transfer.md)
- [007: Serve and announce compile include files](007-serve-announce-include-files.md)
- [009: SystemVerilog language features inside TL-Verilog](009-sv-features-in-tlv.md)
- [010: Agent one-shot tasks via a headless IDE Component](010-headless-components.md)
- [015: Live Doc gaps found in user-model testing](015-live-doc-gaps-from-eecs151-test.md)
- [016: Share CE `sourceAsm` helpers between the CE pane and headless compile](016-share-ce-sourceasm-helpers.md)
- [017: Tool errors are returned as ordinary results, so batches count them ok](017-tool-errors-returned-as-results.md)

## Closed

Older entries link to deleted files; recover those with `git log --follow -- issues/NNN-slug.md`.

- [013: Large results from batched `makerchip_invoke_tool` calls overwrite each other](https://github.com/rweda/makerchip-vscode-extension/blob/7a1e27b/issues/013-batched-large-results-overwrite.md)
  Closed 2026-10-27: verified; a 5-entry, 78 KB batch returned one merged text part, spilled to one file.
- [012: An IDE call made while a panel is still connecting times out](https://github.com/rweda/makerchip-vscode-extension/blob/7a1e27b/issues/012-ide-call-timeout-vs-panel-readiness.md)
  Closed 2026-10-27: likely a red herring (a panel connects in under 3 s; probably the Microsoft
  harness hang). Its errors-reported-as-results point moved to `017`.
- [002: Waveform VCD parser rejects valid batch (non-monotonic) VCDs](https://github.com/rweda/makerchip-vscode-extension/blob/f8c7db3/issues/002-vcd-parser-nonmonotonic-batch.md)
  Closed 2026-10-27: misdiagnosed; batch VCDs are monotonic. Concurrent `fs.appendFile` calls
  reordered cached VCD chunks, so only restore saw backward time. Fixed by 17ae536 (serialized
  `compileCache.appendFile`).
- [005: Headless CE-API compile path (no CE pane)](https://github.com/rweda/makerchip-vscode-extension/blob/f8c7db3/issues/005-headless-ce-api-compile.md)
  Closed 2026-10-27: shipped as `makerchip_ce_compile` (`ceCompile.ts`), with the WARP-V delivery
  handlers deployed (mono, warp-v.org). Helper sharing with CE moved to 016; the visible-CE-UI
  variant remains in 004.
- [011: Feedback from Yashvini](https://github.com/rweda/makerchip-vscode-extension/blob/2751c293/issues/011-yashvini-feedback.md)
  Closed 2026-10-23
- [014: `makerchip_extract_pdf_figure` has no cheap way to survey a document](014-extract-pdf-figure-survey-mode.md)
  Closed 2026-10-16: `summary` with `select: {mode: "all"}` surveys a page (`clusters`, `largest`,
  `images`, `lines`); `ignore` leaves out a frame that joins figures; `render.annotate` tags pool
  ids, outlining `group` sets once. Documented in the `makerchip_extract_pdf_figure` schema and
  mono's `live_doc.md`.
- [008: Let `makerchip_invoke_tool` carry several calls in one invocation](008-invoke-tool-batched-calls.md)
  Closed 2026-09-28: `calls` array on `makerchip_invoke_tool`, run serially in-process so the
  harness sees one call and its one-per-round limit cannot hang; per-entry `fatal` (default true),
  `MAX_BATCH_CALLS`, per-call result headers preserving non-text parts. Rationale now lives in the
  BATCHING note on `InvokeToolTool` in `packages/makerchip-extension/src/makerchipTool.ts`.
- [006: Tool gating and activation](006-tool-gating-and-activation.md)
  Closed 2026-08-28: activation-graph engine, env holders, `makerchip_enable_tools`,
  `makerchip_invoke_tool`, and per-tool `when` gating on all 28 gated tools; Phase B pane-awareness
  dropped. Durable design now lives in `packages/makerchip-extension/src/toolActivation.ts`.
