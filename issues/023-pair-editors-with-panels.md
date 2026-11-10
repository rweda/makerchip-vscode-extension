# 023: Help users see which Makerchip panel goes with which editor

- Status: open
- Area: makerchip-extension (panels, editor title)
- Created: 2026-11-10

Each source file compiles into its own Makerchip panel, whose tab shows the file's name and the Makerchip icon
(`panelNameForFile` in `src/extension.ts`). Users still have to match the two tabs by eye. VS Code lets
extensions read tabs (`window.tabGroups`) but not style, highlight or relabel them, and reports no tab hover or
drag events, so the matching tab can't be "lit up". The options:

- **Linked reveal:** activating a `.tlv` editor brings its panel to the front of the panel's group (without
  focus), and focusing a panel brings its source editor forward. The closest thing to lighting up the partner,
  like the Markdown preview following the active editor, but it can feel pushy; put it behind a setting.
- **Title-bar button state (less pushy):** while the file's panel is open, offer "Show Makerchip Panel"
  (a context key per file, as the Run TT Flow button uses):
  - as the Makerchip button's **Alt+click** alternative (a menu item's `alt` command); a right-click on a
    title-bar button can't be distinguished, since it opens the tab's context menu;
  - and/or as an item in that context menu (`editor/title/context`);
  - and/or as its own title-bar button.
- **File badge:** a 1-2 character `FileDecorationProvider` badge on the editor tab (and in the file Explorer) for
  files with an open panel. Subtle, and it sits beside Git's badge.
- **Status bar item:** while an editor with a panel is active, "$(icon) project.tlv", revealing the panel on
  click.

Line-level linking between the editor and the panel's Nav-TLV view is issue 024, and could be the most natural
pairing cue; consider the two together.
