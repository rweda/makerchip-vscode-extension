# 024: Link editor lines and Nav-TLV lines, as the Makerchip IDE does

- Status: open
- Area: makerchip-extension (webview), mono IDE Plugin API
- Created: 2026-11-10

In the Makerchip IDE, clicking a line number in the editor's gutter or in Nav-TLV's takes you to the
corresponding line in the other. In VS Code the IDE runs without its editor (`hasEditor: false`), so the link
has to cross to VS Code's editor.

- **Nav-TLV (and error log) -> editor:** the IDE already reports these clicks to its host:
  `IdePlugin#onJumpToLine(lineNumber)` (mono `ide-env/coffee/platform/IdePlugin.coffee`), "useful when using
  hasEditor: false mode with an external editor". `VSCodeMakerchip` (`src/webview.ts`) doesn't override it yet:
  override it to post the line to the extension, which reveals and selects it in the panel's source file
  (the panel's file, as recorded by `panelNameForFile` in `src/extension.ts`).
- **Editor -> Nav-TLV:** needs a new Plugin API method in mono wrapping `NavTLV#jumpToLine`, which takes a
  *preprocessed* line number, so the mapping from source lines needs checking. VS Code gives extensions no click
  events on its line-number gutter, but offers the `editor/lineNumber/context` menu ("Show in Nav-TLV" on
  right-click), a command with a keybinding, or following the cursor (`onDidChangeTextEditorSelection`) as an
  opt-in mode.

See 023 (helping users pair editors with panels): this linking is also a pairing cue.
