# 015: Live Doc gaps found in user-model testing

- Status: open
- Area: Live Doc (`pdf.extractToFabric`, PDF view, VIZ), plus the `makerchip_capture_video` and
  `makerchip_compile` tools used alongside it
- Created: 2026-10-14

Found using Live Doc as a user would, without reading `mono` sources: animating EECS 151 lec07
slides 35–36 from a PDF view (unpublished), and
`makerchip_examples/live_doc/shift_register_fsm.tlv`, a viewer for the Katz CS 150 `06-SeqImpl.pdf`
deck.

1. **Some glyphs are dropped.** E.g. the `'` in `1'b0` (EECS 151 slide 36). The Katz cases (overbar
   on `TLC`, "don t") are from fonts without a Unicode map: mono
   `issues/025-labels-from-fonts-without-unicode-map.md`.
2. **VIZ errors are not visible to agents.** `\viz_js` exceptions go to the console and flag the VIZ
   tab with an error status, but no tool reports either. The VIZ User's Guide ("Processing `\viz_js`
   Bodies", "Runtime Errors"; source outside this repo) does not yet mention the tab status, or that
   siblings run `init()` in declaration order, which the deck viewer relies on (a `/deck` scope
   declared first publishes `this.global.slideDeck` for the slides after it).
3. **Second figure appears slow.** With two `extractToFabric` calls on the same view, the second
   figure stayed at "Loading PDF..." in a `get_viz_image` capture taken right after compile, but
   rendered in a later capture. Likely loads are serialized and capture doesn't wait for figures.
   Consider letting captures await pending Live Doc figures.
4. **Capture can't target a known VIZ region.** `makerchip_capture_video` `absolute`-mode `focus`
   and `scale` are not in `\viz_js` (`where:`) units, so zooming in on one slide of a known layout
   required deriving offsets from a full capture and then using `fit-relative` fractions. Accept a
   VIZ-coordinate rectangle to frame, or at least document the coordinate system.
5. **`makerchip_compile` gives a false "unsaved changes" warning.** After a file was edited with the
   agent's edit tools, compile warned about unsaved changes even though the edits were on disk and
   were compiled.
6. **`makerchip_get_viz_image` captures at the pane's on-screen size.** With a narrow VIZ pane, a
   slide-sized figure came back about 320 px wide, too small to read overlay values. Its description
   now points to the workaround, a one-frame `makerchip_capture_video`, but that yields only GIF or
   APNG, not PNG. Give `get_viz_image` `width`/`height` (rendering off-screen like `capture_video`).

Embedded images from a `{view}` source and Type3 font styles are mono `027` and `026`.
