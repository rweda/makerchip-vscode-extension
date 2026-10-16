# 015: Live Doc gaps found in user-model testing

- Status: open
- Area: Live Doc (`pdf.extractToFabric`, PDF view, VIZ, `makerchip_extract_pdf_figure`), plus the
  `makerchip_capture_video` and `makerchip_compile` tools used alongside it
- Created: 2026-10-14

Found using Live Doc as a user would, without reading `mono` sources. Items 1–4 came from animating
EECS 151 lec07 slides 35–36 from a PDF view; that example was not published. Items 5–7 came from
`makerchip_examples/live_doc/shift_register_fsm.tlv`, a viewer for a whole slide deck
(Katz CS 150, `06-SeqImpl.pdf`).

1. **Raster images are not built, silently.** The state diagram on slides 34–36 is an embedded
   image, which `toFabric` skips, so it cannot be shown by reference. The example works around this
   with an original redrawn diagram. Nothing tells the author an image was dropped (only
   `meta.imageCount`), and there is no documented way to render a page (or a region of it) from a
   `view` source. `loadPdfjs` needs a doc, and there is no documented way to get a
   `PDFDocumentProxy` from a view.
2. **Text style is not conveyed.** Labels carry `fontSize` only, with no fill color, font family, or
   weight. Orange callouts and the blue title render black, and monospace code renders in Roboto with
   ragged spacing. The workaround for the font is `onReady` matching code by font size. Some
   glyphs are also dropped, e.g. the `'` in `1'b0` on slide 36. In the Katz deck, the overbar on
   `TLC` (slide 50) is missing and slide 16 shows "don t". It is not yet known whether extraction
   or the deck's hand-written decoder drops these.
3. **VIZ errors are not visible to agents.** `\viz_js` exceptions now go to the console and flag the
   VIZ tab with an error status, but no tool reports either. The VIZ User's Guide ("Processing
   `\viz_js` Bodies", "Runtime Errors") documents child-first `init()` and console errors; its
   source is outside this repo and does not yet mention the tab status or that siblings run
   `init()` in declaration order, which the deck viewer relies on (a `/deck` scope declared first
   publishes `this.global.slideDeck` for the slides after it).
4. **Second figure appears slow.** With two `extractToFabric` calls on the same view, the second
   figure stayed at "Loading PDF..." in a `get_viz_image` capture taken right after compile, but it
   rendered in a later offscreen capture. The likely cause is that loads are serialized and capture
   doesn't wait for figures. Consider letting captures await pending Live Doc figures.
5. **Selectors and overlays depend on the region.** Primitive indices (`nth`, `path`) count from
   the start of the selection, and figure `(0, 0)` is the region corner. Widening a slide's crop to
   its full frame silently shifted every index by +2 and every overlay by (+1.4, +55.1), with no
   error, just wrong highlights. Consider page-stable primitive ids, or selectors in page
   coordinates. At least document the dependence.
6. **Capture can't target a known VIZ region.** `makerchip_capture_video` `absolute`-mode `focus`
   and `scale` are not in `\viz_js` (`where:`) units, so zooming in on one slide of a known layout
   required deriving offsets from a full capture and then using `fit-relative` fractions. Accept a
   VIZ-coordinate rectangle to frame, or at least document the coordinate system.
7. **`makerchip_compile` gives a false "unsaved changes" warning.** After a file was edited with the
   agent's edit tools, compile warned about unsaved changes even though the edits were on disk and
   were compiled.

Garbled text from fonts without a Unicode map (`06-SeqImpl.pdf` needs a hand-written decoder) is
mono `issues/025-labels-from-fonts-without-unicode-map.md`.
