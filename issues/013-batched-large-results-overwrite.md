# 013: Large results from batched `makerchip_invoke_tool` calls overwrite each other

- Status: open
- Area: `makerchip_invoke_tool` (`InvokeToolTool` in `packages/makerchip-extension/src/makerchipTool.ts`)
- Created: 2026-10-12

Copilot Chat spills each large text *part* of a tool result to
`<session>/<toolCallId>/content.{txt,json}`, keyed only by the call ID. A batch used to return one
text part per entry, so with several large entries the spill files overwrote each other (seen with
6 `makerchip_extract_pdf_figure` entries; only page 3 survived). `invokeBatch` now merges adjacent
text parts into one (see BATCHING in `makerchipTool.ts`).

Remaining work:

- Verify in a fresh Extension Development Host chat: a batch of several large extractions should
  spill to one file that contains all of them. Then close this issue.
