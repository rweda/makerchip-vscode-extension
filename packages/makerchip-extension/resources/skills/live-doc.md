---
name: live-doc
description: 'Makerchip Live Doc API — extract vector figures from a PDF and animate them with simulation data in a \viz_js (VIZ) block. Use when: authoring or debugging Live Doc / \viz_js overlays on a PDF, working with this.global.pdf, extractFigure, toFabric, extractToFabric, PDF figure extraction, overlaying simulation values on a diagram/spec/lecture slide, or when the makerchip_extract_pdf_figure tool is relevant.'
applyTo:
  - pattern: "**/*.tlv"
    triggerWords:
      - live doc
      - livedoc
      - extractFigure
      - extractToFabric
      - toFabric
      - this.global.pdf
      - pdf figure
      - pdf overlay
      - viz pdf
user-invocable: true
---

<!--
  Provenance: This document is sourced from the Makerchip mono repository
  (doc-src/public/live_doc.md). It is the authoritative Live Doc API reference.
  The Makerchip VS Code extension bundles it so Copilot has the full API when
  authoring or debugging Live Doc `\viz_js` code. Keep it in sync with mono.
-->

# Live Doc

**Live Doc** is a set of capabilities that support import and animation of originally-static documentation (currently, PDF) using Visual Debug (VIZ). Live Doc supports a no-copy use model so that copyright infringement can be avoided when necessary.

## Concept and Use Models

### What it does

A `\viz_js` block calls `this.global.pdf.extractFigure(source, opts)` to fetch a PDF page, parse its vector drawing operators, and receive the figure's geometry as an array of SVG paths plus text labels—ready to place as `fabric.Path` and `fabric.Text` objects inside the VIZ canvas. `\viz_js` code can assign attributes to these based on simulation data and can provide live overlays so a static diagram comes alive to reflect simulation behavior.

### Use models

**Supplemental course materials** — Create companion visualizations that augment preexisting course materials. Animate a circuit diagram from a lecture slide or textbook page. Let AI generate illustrative stimulus.

**Live design documentation** — Bring existing design specs to life to accurately relate project documentation with actual design simulations.

**VIZ development flow** — Use your favorite drawing tools to seed your VIZ development. AI typically does well at connecting your static drawings with a hardware model.

**Concept video creator** — Thinking outside the box, this same flow can be used outside the world of hardware to explain processes and concepts. Draw a static illustration, and instruct Copilot to render a video using VIZ.

### Copyright model

In consideration of authors' copyrights, Live Doc features support a clear separation between the referenced figure and the Live Doc simulation animation capabilities. Live Doc code may be written to contain *no copy* of the referenced figure. The browser fetches and parses the (PDF, SVG, etc.) content at runtime, holding it only within the browser context. The VIZ code contains only a reference to the PDF (URL or pane ID). This reference provides explicit attribution, but adding attribution `Text` in the VIZ code is recommended. Simulation overlays encapsulated in the VIZ code (values, colors, annotations) are original work, not copied expression. This keeps the use consistent with the accepted interpretation of fair use for programmatic reference.

#### AI agent guidance for authoring Live Docs

Authoring Live Docs as an AI agent inherently shares PDF data with third-party LLMs. Unless you have confirmed that the user has the right to share the PDF or that the LLM terms prohibit training and data retention, **avoid opening the PDF file, parsing it with another tool, or pulling its bytes into context.** The `makerchip_extract_pdf_figure` tool can be used to narrow your data sharing. In addition to its other benefits (exposing exactly the VIZ call results and avoiding context clutter), using it with `includePaths=false` (the default) can avoid the inclusion of the figure's own vector geometry, while other aspects of the figure are less sensitive to copyright.

Encourage Live Doc developers to communicate openly with static content authors and to consult legal counsel.

### Content Access and CORS

The browser's same-origin policy applies to the `fetch` inside `extractFigure`. A PDF server that sends `Access-Control-Allow-Origin: *` (e.g. GitHub Pages, many CDNs) is fetched directly. Live Doc probes the origin once per session and, only when a direct read is blocked, retries through the IDE's CORS proxy — so hosting your own PDF works as long as the server sends that header, and nothing needs to be added to an allowlist.

### Large documents

Live Doc does not download the whole PDF. It reads the page you asked for by byte range, so pulling one figure out of a 33 MB textbook costs about a megabyte. That requires the server to send **`Content-Length`** and **`Accept-Ranges: bytes`**, which static file servers and CDNs normally do. If a server omits them (or serves the PDF gzipped, which makes byte ranges meaningless), pdf.js falls back to fetching the entire file.

Documents that must go through the CORS proxy are additionally limited: 64 MB when the server declares a length, 10 MB when it does not. Over the limit, `extractFigure` rejects with a clear error rather than returning a partial parse — but note that a document reached **directly** has no such ceiling, so the usual fix for a large PDF is to serve it with `Access-Control-Allow-Origin: *` instead of relying on the proxy.

### Inspecting a PDF (the `makerchip_extract_pdf_figure` tool)

Before writing Live Doc code, **inspect the PDF** with the `makerchip_extract_pdf_figure` tool. It runs the *exact same* `this.global.pdf.extractFigure(source, opts)` that your `\viz_js` VIZ code will use at runtime, so the coordinates, labels, cluster selection, figure bbox, and coordinate `transforms` it returns match precisely what your VIZ overlay will see — no drift between what you inspect and what runs. Additionally, it provides narrower results to avoid clutter and potentially-copyrighted data in the context window.

Use it to:

- **Find anchor coordinates** — read `primitives[].bbox` (wire midpoints) to place overlay chips with `fig(...)`.
- **Choose a `select` mode / cluster index** — try `{mode:"largest"}`, `{mode:"cluster", index:N}`, or a `{mode:"region", rect:[…], space:"device"}` crop and see which primitives/labels land in the figure.
- **Discover pool indices** — read the `labels` and `primitives` arrays to pick the integer indices you will name in `toFabric`/`extractToFabric`'s `labels`/`primitives` opts.
- **Read the coordinate `transforms`** for manual coordinate conversion.

Tool notes:

- `source` must be a **URL reachable from the Makerchip IDE** (fetched through its CORS proxy, exactly like `\viz_js`). Local files must be served at a URL (e.g. mono serves `ide-env/public/` at `/module/ide/`, so a file in `ide-env/public/tmp/foo.pdf` is reachable at `/module/ide/tmp/foo.pdf`).
- Requires an **open Makerchip panel** (extraction runs in the IDE browser context). It does **not** require a compiled design or simulation data.
- SVG path `d` strings are omitted by default. That keeps the result compact, and it also keeps the figure's own geometry out of model context — `d` is the drawing itself, not metadata about it. Set `includePaths: true` only when you actually need exact vector paths, and never copy the returned `d` strings into `.tlv` source (see the copyright model below).
- The tool inputs mirror `extractFigure`'s `opts`: `page`, `select`, `gap`, `space`, `text`, `clip`.

Once you understand the figure, write the `\viz_js` code using the API below.

---

## API Reference

Live Doc is exposed to `\viz_js` code as:

```js
this.global.pdf   // → the PdfExtractor module
```

---

### `extractFigure(source, opts)` → `Promise<ExtractResult>`

The primary entry point. Fetches the PDF (or reuses the cache), parses the requested page, selects the figure, and returns primitives + labels in the chosen coordinate space.

#### `source`

| Form | Meaning |
|------|---------|
| `"https://..."` | URL string — fetched by the browser (CORS applies) |
| `{url: "https://..."}` | Same, with explicit object form |
| `{data: ArrayBuffer}` | Raw PDF bytes (from an extension-host bridge for local files) |
| `{pane: "mnemonic", fingerprint}` | A PDF already open in a PDF pane — see [Figures from a loaded PDF](#figures-from-a-loaded-pdf) |
| PDFDocumentProxy | Already-opened pdf.js document — passed through unchanged |

Documents opened by URL are **cached** across compilations (keyed by URL). Re-compiling the same design does not re-fetch the PDF.

#### Figures from a loaded PDF

`{pane: "mnemonic"}` extracts from a document already open in a PDF pane, which is how a figure comes from a **local file** — a licensed copy of a textbook or spec that no URL can reach. Load the PDF into a pane first (the IDE's file menu, or the VS Code extension), then name that pane:

```js
this.global.pdf.extractToFabric(fabric, {pane: "mybook"}, {
   extract: {page: 342, select: {...}},
   build:   {left: 10, top: 10, into: figure},
})
```

The extraction runs *inside* the pane, which already holds the parsed document, and only the resulting geometry crosses back. So nothing is re-parsed, no bytes are copied, and no second copy of pdf.js is loaded. It also keeps your `.tlv` free of any copy of the figure: the source names a pane, and the geometry is re-derived at runtime from the document the reader supplies.

##### Naming the pane

The mnemonic is the pane's tab label, and you have three ways to name it:

| `pane` | Resolves to |
|--------|-------------|
| `"latches.pdf"` | that pane, by exact name |
| `"latch"` | the one open PDF whose name starts with it — a unique prefix, like an abbreviated git SHA |
| `""` (or omitted) | the sole open PDF pane |

Prefix matching exists because a pane's name is uniquified on collision (`book`, `book+2`), so the name a `.tlv` was authored against may not be the name it gets. An exact match always wins outright, so `"book"` still means `book` even when `book+2` is also open.

Ambiguity is always an error, never a guess — it lists the candidates, since animating the wrong document is worse than failing.

##### Verifying the document: `fingerprint`

The reader supplies their own copy of the PDF, so its *file name* says little about its contents. An optional `fingerprint` identifies the document itself:

```js
{pane: "", fingerprint: "a1b2c3d4e5f60718"}   // whichever open PDF this actually is
{pane: "book", fingerprint: "a1b2c3d4e5f60718"}  // that pane, and check it is the right document
```

It comes from the PDF's trailer `/ID`, available as `fingerprints` — `[original, modified]`; either matches. Use `extractFigure`'s result during authoring, or the pane's `getInfo`, to read it once.

With a name, `fingerprint` **verifies** rather than selects, and that is the point: a different printing of the same book has different fingerprints, so you get a clear error instead of an overlay silently landing on a shifted layout. Your `labels` and `primitives` indices are authored against one layout, so a mismatch really is a problem worth hearing about.

A byte-identical publisher distribution matches for every reader. A per-purchaser watermarked copy will not.

#### `opts`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `page` | number | `1` | 1-based page number |
| `select` | object | `{mode:"largest"}` | Figure selection (see below) |
| `gap` | number | `12` | Cluster-join proximity in device pixels (cluster modes only) |
| `space` | `"figure"` \| `"device"` \| `"pdf"` | `"figure"` | Output coordinate space for primitives and labels |
| `text` | `"labels"` \| `"all"` \| `"none"` | `"labels"` | Which text items to return |
| `clip` | `bool` \| `number` | `false` | Drop primitives whose device bbox falls outside the figure (+pad). `true` uses pad 4; a number sets the pad. Removes the need for a manual consumer-side filter (see region-select note). |
| `splitSubpaths` | `bool` | `true` | `false` keeps whole paths as single primitives — see [Primitives, paths, and `path`](#primitives-paths-and-path) |

#### Primitives, paths, and `path`

A **primitive is a subpath** — one `M…` run of a PDF path. A PDF is free to emit many separate lines as a single compound path, and drawing tools routinely do, so a path is not a logical element: one path can hold a dozen unrelated wires, or four crop marks in opposite corners.

Each primitive therefore carries **`path`**, the index of the PDF path it came from. Subpaths of one path share a `path`, which makes the grouping addressable via `path` as a selector filter:

```js
primitives: {
   bundle: {path: 16, all: true},         // every subpath of PDF path 16 -> array of refs
   wire:   {path: 16, nth: 7},            // just its 8th
   near_j: {path: 16, near: [32, 48.8]},  // the one nearest a point, within that path
}
```

`all: true` takes every candidate; without it a filter still resolves to one (`nth` defaults to `0`). It works with `str` too, so `{str: "0", all: true}` names every `"0"` label.

Subpath granularity is what makes `{mode:"largest"}` usable. Clustering joins primitives by bbox proximity, and a compound path's bbox can span the whole page — crop marks being the usual culprit. One such bbox touches everything, so the page collapses into a single cluster and "the largest figure" becomes the entire page, header and all. Split, a crop-marked textbook page yields 18 clusters and `largest` finds the circuit.

Still a starting point rather than a replacement for a crop: on that page `largest` omits an output label sitting a little apart from the wires, which a hand-tuned `{mode:"region"}` rect catches.

Two details worth knowing:

- Only **unfilled** paths are split. Splitting a filled path would break even-odd holes, since each ring would become its own path and stop subtracting. Wires are stroke-only, so this costs nothing where it matters.
- A `path` means "drawn together", not "belongs together". PDFs batch same-styled strokes for efficiency, so a group may be a gate outline or may be meaningless — nothing in the file distinguishes them.

`splitSubpaths: false` turns splitting off, keeping whole paths as single primitives.

#### `opts.select` — figure selection modes

| Mode | Extra fields | Behaviour |
|------|-------------|-----------|
| `{mode:"largest"}` | — | Densest primitive cluster on the page (default) |
| `{mode:"cluster", index}` | `index` (0-based) | Nth-densest cluster |
| `{mode:"clusterAt", at:[x,y], space}` | `at`, `space` | Cluster at or nearest a given point |
| `{mode:"region", rect:[x0,y0,x1,y1], space}` | `rect`, `space` | Explicit crop rectangle — keeps every primitive whose bbox intersects the rect |
| `{mode:"all"}` | — | Entire page vector content |

`space` on a selection descriptor specifies the coordinate system of the input point/rect:
- `"device"` — canvas pixels, y-down, origin top-left (recommended for region crops)
- `"pdf"` — PDF user space, y-up, origin bottom-left
- `"norm"` — fractions [0..1] of the device page box

**Note on region select:** `mode:"region"` includes any primitive that *intersects* the crop rectangle and returns its **full** geometry (not clipped). Full-page background rectangles often intersect any region. Pass `clip: true` to drop primitives that fall outside the figure automatically:

```js
extractFigure(source, {select: {mode:"region", rect, space:"device"}, clip: true})
```

`clip: true` uses a 4px pad; pass a number for an explicit pad. Without `clip`, filter on the consumer side (or just let `toFabric` build the parts — it consumes whatever `extractFigure` returns).

#### Return value: `ExtractResult`

```js
{
  primitives: [            // vector paths in `opts.space`
    {
      id,                  // "p0", "p1", ...
      d,                   // SVG path string (M/L/C/Q/Z, ready for new fabric.Path)
      fill,                // CSS color string, or "" if none
      stroke,              // CSS color string, or "" if none
      strokeWidth,         // 0 for fill-only paths (important: prevents Fabric bbox inflation)
      fillAlpha,           // 0..1
      strokeAlpha,         // 0..1
      bbox,                // [minX, minY, maxX, maxY] in output space
      path,                // index of the PDF path this came from (see `splitSubpaths`)
      // Stroke decoration, PRESENT ONLY when the PDF asked for something other than the
      // default. Names and values are Fabric's, so they spread straight onto a fabric.Path.
      strokeLineCap,       // "round" | "square"   (absent = "butt")
      strokeLineJoin,      // "round" | "bevel"    (absent = "miter")
      strokeMiterLimit,    // number               (absent = 10)
      strokeDashArray,     // [on, off, ...] in output-space units (absent = solid)
      strokeDashOffset,    // number, same units   (absent = 0)
    },
    ...
  ],
  labels: [                // text items (filtered to figure bbox when text="labels")
    {
      id,                  // "t0", "t1", ...
      str,                 // text string
      x, y,                // top-left position in output space
      fontPx,              // approximate font size in output-space pixels
    },
    ...
  ],
  space,                   // the opts.space that was used
  figure: {                // bounding box of the selected figure
    width, height,         // in output-space units
  },
  bbox: {
    device: [x0,y0,x1,y1], // figure bbox in device space
    pdf:    [x0,y0,x1,y1], // figure bbox in PDF user space
  },
  page: {
    width, height,          // page dimensions in device pixels
  },
  transforms: {             // affine matrices [a,b,c,d,e,f] for manual coordinate conversion
    pdfToDevice,            // PDF user space → device px
    deviceToPdf,
    deviceToFigure,         // device px → figure space (translate only)
    figureToDevice,
    pdfToFigure,
  },
  meta: {
    selectMode,             // the mode that was used
    clusterCount,           // number of clusters found (null for region/all)
    droppedPrims,           // primitives discarded by the selection
    imageCount,             // raster images encountered (not extractable as vectors)
    totalPrims,             // total vector primitives on the page before selection
  },
}
```

---

### `toFabric(fabric, ext, opts)` → `{group, parts, fig, origin, elements}`

Convenience helper that turns an `ExtractResult` into a ready-to-place `fabric.Group` and an origin-corrected anchor mapper. It performs: build parts → measure content origin → nest at an offset → compute anchors → resolve named elements.

`fabric` is passed in rather than imported, so the extractor module stays fabric-independent. Inside `\viz_js`, the per-canvas `fabric` clone is already in scope, so just forward it.

#### `opts`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `left` | number | `0` | Box-space x at which the figure's content top-left is placed |
| `top` | number | `0` | Box-space y at which the figure's content top-left is placed |
| `labels` | `{name: selector}` | — | Name label texts for live mutation; adds them to `elements`. See [Named element access](#named-element-access-labels-and-primitives). |
| `primitives` | `{name: selector}` | — | Name path primitives for live mutation; adds them to `elements`. See [Named element access](#named-element-access-labels-and-primitives). |
| `labelFill` | string | `"#111"` | Fill color for label text |
| `fontFamily` | string | `"Roboto"` | Font family for label text |
| `into` | fabric.Group | — | Existing group to fill; encapsulates the `group=null` `addWithUpdate` dance |

> To suppress labels entirely, drop them at **extraction** time with `text: "none"` (`extractFigure`'s `text`, or `extract.text` via `extractToFabric`) rather than at build time.

#### Return value

| Field | Type | Description |
|-------|------|-------------|
| `group` | fabric.Group | The built figure group, placed at (`left`, `top`) |
| `parts` | Array | The individual `fabric.Path`/`fabric.Text` objects |
| `fig` | `(fx, fy) → {x, y}` | Maps figure-space coords to box space, corrected for the content's actual origin so overlays register to the rendered geometry |
| `origin` | `{x, y}` | The measured content top-left in figure space (`fx0, fy0`) |
| `elements` | `{name: fabric.Text \| fabric.Path \| Array}` | The named refs from `opts.labels` / `opts.primitives`, merged flat. These objects live **inside** the group — mutate them in `render()` (`el.set({...})`) then `requestRenderAll()`. See [Named element access](#named-element-access-labels-and-primitives). |

```js
const {fig} = this.global.pdf.toFabric(fabric, ext, {left: OFFX, top: OFFY, into: figure})
this._pos = { a: fig(32, 48.8), b: fig(32, 71.3) }   // anchors land on the wires
```

Anchor coordinates come from wire midpoints (`primitive.bbox`), not label positions — labels sit near but not on the wires.

---

### `extractToFabric(fabric, source, opts)` → `Promise<{ext, group, parts, fig, origin, elements}>`

The one-call entry point for `\viz_js`. Extracts the figure and builds the Fabric group in a single step — equivalent to `extractFigure(source, opts.extract).then(ext => toFabric(fabric, ext, opts.build))`.

Options are **nested, one group per stage**:

| Group | Options | Runs |
|-------|---------|------|
| `extract` | `page`, `select`, `gap`, `space`, `text`, `clip` | in the PDF pane for a `{pane}` source, else here |
| `build` | `left`, `top`, `into`, `labels`, `primitives`, `labelFill`, `fontFamily` | always here, where the canvas is |

```js
const {fig} = await this.global.pdf.extractToFabric(fabric, source, {
   extract: {page: N, clip: true, select: {mode: "region", rect: [...], space: "device"}},
   build:   {left: OFFX, top: OFFY, into: figure},
})
this._pos = { a: fig(32, 48.8), b: fig(32, 71.3) }
```

The nesting is not cosmetic. For a `{pane: ...}` source the two stages run in **different realms** — extraction in the pane, which holds the parsed document, and the Fabric build here, where the per-canvas `fabric` lives. The `extract` group is what crosses between them, so it must be plain data; `build.into` is a live `fabric.Group` and could never cross. Keeping the groups separate also means neither constrains the other's option names.

The result also carries `ext` (the full `ExtractResult`) and `parts` (the individual Fabric objects), so nothing is lost versus the two-step form:

- Reach for `extractFigure` alone when **authoring** — inspect `ext.primitives[].bbox` and `ext.labels` to discover the wire coordinates you hardcode into anchors, and the pool indices you name in `labels`/`primitives`.
- Reach for `toFabric` (or the returned `parts`) for **live manipulation** — e.g. recoloring a specific extracted wire per cycle.
- Reach for `extractToFabric` for the **common case** — a static figure with either overlay chips (via `fig` anchors) or named elements mutated in place (via `labels`/`primitives`).
- Use `labels`/`primitives` when the **PDF itself has the wire values / paths** you want to drive from simulation. Name them by pool index (discovered once during authoring), then mutate the returned `elements` refs directly in `render()` — no per-cycle object creation. See [Named element access](#named-element-access-labels-and-primitives).

---

### Named element access: `labels` and `primitives`

`toFabric` and `extractToFabric` accept `labels` and `primitives` opts that **name** specific extracted elements for direct manipulation in `render()`. Named elements **remain in the Fabric group**; `render()` mutates them in place. The result gains a flat merged `elements` object whose keys are the names you chose (they must not collide across the two pools):

```
elements: { [name]: fabric.Text | fabric.Path | Array<fabric.Text | fabric.Path> }
```

#### The common case: index a static PDF

A VIZ figure is often written against **one specific, unchanging PDF**, so there is no survivability concern: name each element by its **integer index** into the pool.

```js
this.global.pdf.extractToFabric(fabric, source, {
   extract: { /* page, select, clip, ... */ },
   build: {
      labels: {
         s_val: 6,      // ext.labels[6] — the "0" on the S wire
         r_val: 7,      // ext.labels[7] — the "0" on the R wire
         q_val: 8,      // ext.labels[8] — the "1" on the Q wire
      },
      primitives: {
         s_wire: 15,    // ext.primitives[15] — a path
      },
   },
}).then(({elements}) => {
   this._el = elements   // {s_val: fabric.Text, r_val: fabric.Text, q_val: fabric.Text, s_wire: fabric.Path}
})
```

`render()` mutates the named refs and requests a redraw:

```js
render() {
   this._el.s_val.set({text: String(sVal), fill: sVal ? "#2e7d32" : "#e65100"})
   this._el.r_val.set({text: String(rVal), fill: rVal ? "#2e7d32" : "#e65100"})
   this.getCanvas().requestRenderAll()
   return []
}
```

> **Quote convention in `.tlv` files.** Inside a `\viz_js` block, **single quotes are TLV identifier syntax** — `'$sig'.asInt()` reads a pipeline signal, and `'/scope$sig'` adds a hierarchy prefix. A single-quoted string whose content is not a valid TLV identifier (e.g. a color `'#2e7d32'`) is a parse error. Use **double quotes for all non-signal strings** in `\viz_js` (`"#2e7d32"`, `"round"`, etc.). (Plain JS outside a `.tlv` file has no such restriction.)

**Pool arrays.** The integer indexes a per-pool array, so the two opts have independent namespaces: `labels: {x: 6}` → `ext.labels[6]`; `primitives: {y: 6}` → `ext.primitives[6]`.

**Grouping several indices.** An **array of integers** names a group of elements in one key; the result is an array of refs in the same order:

```js
labels: { in_vals: [2, 4, 8] }   // → elements.in_vals = [ext.labels[2], ext.labels[4], ext.labels[8]]
```

Iterate it directly: `this._el.in_vals.forEach((t, i) => t.set({text: String(vals[i])}))`.

**Discovery workflow.** Log the pools once during authoring (`extractFigure`, or inspect `ext` from `extractToFabric`), read off the indices, and hardcode them. Indices are stable as long as the `select` crop rect and the source PDF layout do not change; for a frozen PDF this never happens, so the bare index is the cheapest and clearest choice.

```js
// ext.labels for page 9, clip [242,456,350,540]:
//   0:"-"  1:"Coupled NANDs (R"  2:"S"  3:"R"  4:"Q"  9:"~Q"
//   5:"1"(~Q wire)  6:"0"(S wire)  7:"0"(R wire)  8:"1"(Q wire)
```

#### Full API: filters and selectors

When the PDF may see minor edits — or when you want the selection to be self-describing — replace the bare integer with a **selector object**, resolved in two stages:

```
pool  ──filter──▶  candidates  ──select──▶  result
```

1. **Filter properties** narrow the pool to a candidate set (all AND-combined).
2. **Selector properties** pick one (or several) from that candidate set.

A bare integer is shorthand for the no-filter case: `s_val: 6` ≡ `s_val: {nth: 6}`.

**Filter properties** (narrow the candidate set):

| Property | Pool | Effect |
|----------|------|--------|
| `str: 'text'` | labels | Keep only labels whose content matches |
| `path: N` | primitives | Keep only primitives from PDF path `N` (see `splitSubpaths`) |

*(future filters — `stroke`, `fill`, `xobj` for primitives — slot in here without touching the selection stage.)*

**Selector properties** (pick from candidates, applied **after** filtering):

| Property | Effect |
|----------|--------|
| `nth: N` | The Nth candidate in array order (default `0`) |
| `nth: [a, b, …]` | Several candidates, in the given index order → array result |
| `near: [x, y]` | The candidate closest to this figure-space point |
| `all: true` | Every candidate, in pool order → array result |

`nth` and `near` are mutually exclusive. Because they apply after filtering, `{str: '0', nth: 1}` means "the 2nd candidate *among the '0' labels*", not the 2nd label overall.

**Multi-element selectors (arrays).** When the selector value is an array, the result is an array of fabric refs in the same order. Two ways to express a group:

```js
labels:     { input_vals: [{str:'0', nth:0}, {str:'1', nth:1}] },  // array of selectors
primitives: { gate_paths: {nth: [3, 4, 5, 7]} },                    // single selector, array nth
// → elements.input_vals = [fabric.Text, fabric.Text]
// → elements.gate_paths = [fabric.Path, fabric.Path, fabric.Path, fabric.Path]
```

Result order follows the selector array / `nth` array order exactly.

---

### Matrix helpers

Exposed for working with the `transforms` matrices returned by `extractFigure`. All matrices use the PDF convention `[a, b, c, d, e, f]` where a point transforms as `x' = a*x + c*y + e`, `y' = b*x + d*y + f`.

| Export | Signature | Description |
|--------|-----------|-------------|
| `applyPt` | `(m, x, y) → [x', y']` | Transform a point |
| `mul` | `(m, n) → m∘n` | Compose two matrices (n applied first) |
| `invert` | `(m) → m⁻¹` | Invert an affine matrix |
| `scaleOf` | `(m) → number` | Uniform scale factor (√\|det\|) |
| `transformRect` | `(m, [x0,y0,x1,y1]) → [minX,minY,maxX,maxY]` | Transform an axis-aligned rect |
| `translate` | `(dx, dy) → m` | Build a translation matrix |
| `IDENTITY` | `[1,0,0,1,0,0]` | Identity matrix |

---

### `config`

```js
this.global.pdf.config.pdfjsUrl  // override pdf.js bundle URL
this.global.pdf.config.workerUrl // override pdf.worker.mjs URL
```

---

### `loadPdfjs()` → `Promise<pdfjsLib>`

Escape hatch: returns the underlying pdf.js library object. Useful for advanced use cases (e.g. rendering a page to a canvas for visual reference, or reading document metadata).

---

## Coordinate Spaces

| Space | Origin | Y-axis | Units |
|-------|--------|--------|-------|
| `"pdf"` | Bottom-left of page | Up | PDF points |
| `"device"` | Top-left of page | Down | Canvas pixels at scale 1 |
| `"norm"` | Top-left of page | Down | Fraction of page box [0..1] |
| `"figure"` | Top-left of selected figure | Down | Canvas pixels (= device - figure origin) |

Use `"figure"` (the default) when building Fabric objects: the figure's top-left is `(0, 0)` and you control its placement by setting `left`/`top` on the group. Use `"device"` when specifying region crop rectangles, to avoid the ambiguity in the PDF y-up convention.

---

## Rendering Pattern

There are two live-figure patterns. Pick by whether the driven values already exist **in the PDF**:

- **Named elements (mutate in place)** — the PDF has the wire values/paths you want to drive. Name them with `labels`/`primitives`, then mutate the returned `elements` refs in `render()`.
- **Overlay chips (persistent widgets)** — the PDF has no value labels (or you're adding annotations). Compute anchor positions with `fig(...)` once in `init()`, create chip widgets once, and mutate them in `render()`.

### Named elements (mutate in place)

```js
init() {
   let figure = new fabric.Group([], {originX:"left", originY:"top",
                                      selectable:false, evented:false})
   this._pdfReady = false

   // Persistent widgets created once in init(), mutated in render().
   let status = new fabric.Text("", {left:4, top:101, fontSize:9, fill:"#1565c0"})

   const OFFX = 10, OFFY = 22
   this.global.pdf.extractToFabric(
      fabric,
      {url: "https://..."},
      {extract: {page: N, clip: true,
                 select: {mode: "region", rect: [...], space: "device"}},
       build:   {labels: {s_val: 6, r_val: 7, q_val: 8},   // named by pool index
                 left: OFFX, top: OFFY, into: figure}}
   ).then(({elements}) => {
      this._el = elements          // refs live inside `figure`
      this._statusLabel = status
      this._pdfReady = true
      this.getCanvas().requestRenderAll()
   })

   return {figure, status}          // persistent widgets returned from init()
},

render() {
   if (!this._pdfReady) return []
   const E = this._el
   E.s_val.set({text: String(sVal), fill: sVal ? "#2e7d32" : "#e65100"})
   E.q_val.set({text: String(qVal), fill: qVal ? "#2e7d32" : "#c00"})
   this._statusLabel.set({text: mode})
   return []
}
```

The `elements` refs sit two levels deep (outer `figure` group → the built group → text/path parts). Fabric 4 repaints them after `render()` returns.

### Overlay chips (persistent widgets)

```js
init() {
   let figure = new fabric.Group([], {originX:"left", originY:"top",
                                      selectable:false, evented:false})
   this._pdfReady = false
   const OFFX = 12, OFFY = 30

   this.global.pdf.extractToFabric(
      fabric,
      {url: "https://..."},
      {extract: {page: N, clip: true,
                 select: {mode: "region", rect: [...], space: "device"}},
       build:   {left: OFFX, top: OFFY, into: figure}}
   ).then(({fig}) => {
      // Use primitive.bbox midpoints (not label positions) for anchor coords.
      // fig() corrects for the content origin so anchors land on the rendered wires.
      const P = fig(32, 48.8)   // signalA anchor
      this._chip = new fabric.Text("", {left: P.x, top: P.y, fontSize: 9})
      this._pdfReady = true
      this.getCanvas().requestRenderAll()
   })

   return {figure}   // chip is not returned here — added separately if needed
},

render() {
   if (!this._pdfReady) return []
   this._chip.set({text: String(val), fill: val ? "#2e7d32" : "#e65100"})
   return []
}
```

> The single-call `extractToFabric` covers both patterns. For authoring (inspecting the
> extracted geometry to find anchor coordinates and pool indices) or advanced live
> manipulation, use the composable `extractFigure` and `toFabric` primitives directly —
> `extractToFabric` also returns `ext` and `parts` if you want both at once.

---

## Examples

Examples live in `makerchip_examples/live_doc/`.

### `pdf_viz_mux_demo.tlv`

Live 2:1-MUX + AND gate. Extracts page 12 of a lecture PDF (`logic2.pdf`) using a region crop. A free-running counter drives all signal combinations; green/grey value chips overlay each wire, and an orange ring highlights the selected MUX input.

Source PDF: https://cs2461-2020.github.io/lectures/logic2.pdf (Apache-licensed course material, GitHub Pages serves with `Access-Control-Allow-Origin: *`).

### `rs_latch.tlv`

NAND R-S Latch (first sequential-logic Live Doc example). Extracts the bottom-half circuit from page 9 of `latches.pdf` — "Storage: Cross-Coupled NANDs (R-S Latch)". A 16-cycle counter cycles through HOLD → SET → HOLD → RESET phases. Active-low S and R inputs use the `>>1$signal` relative-reference idiom for state. Orange chips mark the asserted (low) input; the operation label (SET/RESET/HOLD) appears below the canvas.

Source PDF: https://cs2461-2020.github.io/lectures/latches.pdf page 9, region `[242, 456, 350, 540]` (device px).

### `d_latch.tlv`

Gated D-Latch. Extracts the bottom-half circuit from page 11 of `latches.pdf` — "Gated D-Latch: Preventing Illegal State of RS Latch". An 8-cycle counter alternates between HOLD (WE=0) and TRANSPARENT (WE=1) phases; D changes every 2 cycles so both capture transitions are visible. An orange ring on the WE chip signals transparent mode; the operation label switches between "TRANSPARENT (Q follows D)" and "HOLD (Q locked)".

Source PDF: https://cs2461-2020.github.io/lectures/latches.pdf page 11, region `[188, 593, 397, 681]` (device px).

## Working with the user

### Preparing to work on a Live Doc

When a user asks you to create a Live Doc, it is important to be clear on a few points. If not already evident, ask questions like:

1. "What are the licensing terms of the original content? Are you the author, or do you have the right to copy it? (If you don't, I will provide overlay and set visual properties without copying elements into the VIZ code, but legal review may be needed.) Are there attribution requirements?" The parenthetical is important for two reasons: 1. it reassures the user that progress can be made without copying content to avoid a false affirmative from a user who fears being blocked; 2. it provides a legal disclaimer. In rare cases, there may even be patent consideration that warrant clarification.

2. "Do you want me to leverage diagram as is or make improvements?" Without legal rights, direct leverage only (by reference) is a necessity. Alternatively, the diagram can be altered entirely to avoid mimicking any of its design. Direct leverage can be important for companion material to maintain a clear connection to the original. If the original is merely an inspirational starting point, it may be better to create a new diagram that is optimal for animation.

3. "How likely it is that subsequent versions of the original diagram will become available?" If uprevving may be necessary, and the original is leveraged by reference, consider the use of filtering features to minimize the likelihood of breaking changes. If copying is an option, mimicking elements as fabric.js code might minimize future maintenance in the face of change.

4. "Is there an existing HDL model providing VCD trace data, or should I create HDL code to drive stimulus? Should the stimulus model use TL-Verilog or something else? Should it be structured to run self-contained in Makerchip or to simulate and generate a VCD externally?"

If the user does not have the rights to the original content, also ask:

"If the PDF is copy-protected, might your LLM provider for this conversation be authorized to train on conversation data or retain it for an extended period? If so, I need to avoid reading the PDF directly. Your LLM settings may provide an option." Ask **before** the first `makerchip_extract_pdf_figure` call, and carefully avoid reading copyright-protected data from the PDF if protected, reporting your limitations rather than risking infringement.

### Addressing hurdles

A primitive is a PDF path, not a logical element. One path may, for example, hold several wires. This can defeat the ability to style programmatically-extracted wires to indicate activity. **Legal considerations must always take precedence**. Never risk copyright infringement. If meeting goals would impose legal risk, stop, and explain the situation.

## Attribution

If attribution is required by the license, or even if it isn't, it is good practice to provide a clear attribution to the original content in the visualization as well as in the VIZ code. For example, overlay `fabric.Text("Extracted from: <URL>", ...)` or a license-compliant attribution positioned in the lower right of the diagram.
