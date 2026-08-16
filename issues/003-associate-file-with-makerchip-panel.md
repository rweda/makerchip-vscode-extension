# 003: Associate a compiled file with its Makerchip panel and reuse it

- Status: open
- Area: makerchip-extension / makerchip_compile, panels, WebviewPanelSerializer
- Created: 2026-08-16

## Problem

There is currently **no association between a VS Code editor/file and the Makerchip panel that
compiled it**. Every compile path is string-based and panel targeting is purely by name: callers
either pass an explicit `panelName` or fall back to `'default'`
(`src/extension.ts` → `callIDE()` uses `panelName || 'default'`; `panels` is a `Map<string, WebviewPanel>`
keyed by that name). So compiling the same `filePath` again — from a VS Code editor action or from
`makerchip_compile` with no explicit `panel` arg — does not reuse the panel that already shows that
file's results; it just hits `'default'` (or opens/creates it).

## Desired behaviour

When `makerchip_compile` is given a `filePath`:

1. Record an association `filePath → panelName` (the panel it compiled into).
2. On a later compile of the **same** `filePath` with **no explicit `panel`** arg — whether triggered
   from a VS Code editor or from `makerchip_compile` — if that associated panel still exists
   (`panels.has(name)`), target it instead of `'default'`.
3. Persist/restore the mapping across VS Code reloads, alongside the existing panel state.

## Notes / implementation sketch

- The mapping is small state: `Map<fsPath, panelKey>`. Prune entries when a panel is disposed
  (there is already panel-disposal handling near the `panels` map) and when a panel is renamed.
- Reload story already exists to hook into: `registerWebviewPanelSerializer('makerchip', …)` restores
  each panel from persisted state `{ panelKey, compileId, layoutState }` and re-runs `setupPanel()`.
  The file↔panel map should be saved/restored the same way (e.g. add to the serialized state, or keep
  a separate `context.workspaceState` entry keyed by `panelKey`).
- Precedence must stay explicit-first: an explicit `panelName` arg always wins over the association;
  the association only fills in the "no explicit panel" case (today's implicit `'default'`).
- Edge cases: same file compiled into multiple named panels (last-writer-wins, or keep first?),
  file renamed/moved on disk, and the `code`/active-editor paths (no `filePath`, so no association —
  leave as-is).

See `src/extension.ts` (`callIDE`, `panels`, serializer) and
`packages/makerchip-extension/src/makerchipTool.ts` (`filePath` branch of `makerchip_compile`).
