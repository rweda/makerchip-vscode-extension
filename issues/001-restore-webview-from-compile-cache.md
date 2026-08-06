# 001: LM tool to open/restore a webview from the compile cache

- Status: open
- Area: makerchip-extension / LM tools, compileCache, webview
- Created: 2026-08-03

## Problem

There is currently **no Language Model tool to load/restore a Makerchip webview from the compile
cache** by `compileId`. The agent-facing tool set (`packages/makerchip-extension/package.json` →
`contributes.languageModelTools`) can start a *fresh* compile (`makerchip_compile` /
`makerchip_wait_compile`) and drive an already-open panel (`makerchip_get_viz_image`,
`makerchip_capture_video`, `makerchip_set_cycle`, layout/pane tools, etc.), but nothing opens a panel
from a previously cached compile. To revisit a prior result an agent must recompile it, even though
all of the data needed to render it is already on disk.

Note that a **restore flow already exists for VS Code reload** — it just isn't exposed as a tool:

- `src/extension.ts` registers a `WebviewPanelSerializer('makerchip')`. On reload VS Code hands back
  the persisted state (`{ panelKey, compileId, layoutState }`) and `setupPanel()` re-wires the panel.
- `src/webview.ts` then runs the reload-restore handshake: the webview posts `restoreRequest`, the
  extension reads the cached result files + `metadata.json` from disk and posts `restoreData`, and the
  webview applies the saved layout and injects the payloads into the IDE
  (`compilation*` / `ide.api.setLayoutState`) so the panes render **without a recompile**.
- `src/compileCache.ts` already persists everything this needs per `compileId`: `top.tlv` (+ `src/`
  siblings), `metadata.json`, `vlt_dump.vcd`, `parse_model.json`, `navtlv.html`, `graph.svg`.

So the capability is present internally; it is only ever triggered by VS Code's own webview
deserialization, never on demand from an agent.

## Options

1. **New LM tool `makerchip_open_compile` (recommended).** Input: `compileId` (and optional
   `panelName`, `layoutState`, `cycle`). It would open/reuse a panel and drive the *same* restore path
   used on reload — construct the panel with persisted state `{ panelKey, compileId, layoutState }`
   and let the existing `restoreRequest` → `restoreData` injection populate it from the cache. No
   recompile, no server round-trip.
2. **Extend `makerchip_wait_compile`** to accept a cached `compileId` and attach it to a panel. Muddier
   — it conflates "wait for an in-flight compile" with "restore a finished one."
3. **Do nothing / recompile.** Wasteful (re-runs SandPiper + Verilator) and can drift from the exact
   cached result the history/`compile-history.json` points at.

## Recommendation

Add tool `makerchip_open_compile(compileId, panelName?, layoutState?, cycle?)` that reuses the
reload-restore injection path in `webview.ts`/`extension.ts` and the cache accessors in
`compileCache.ts` (`getCompileDir`, `loadMetadata`, `RESULT_FILES`). This makes the LLM's cached
compile history (`makerchip_compile`'s `compileId`s) directly re-openable, which pairs naturally with
the existing "reference data for LLM agents" purpose of the cache.

## Notes

- Verify whether restore should re-fetch `navtlv.html` / `graph.svg` from the server compile cache
  (`/compile/<id>/...`) instead of local files, per the note at the top of `compileCache.ts`.
- Pruning: an "open from cache" tool should fail gracefully (clear message) when a `compileId` has been
  pruned per the age-based policy in `compileCache.ts`.
