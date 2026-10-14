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

## Live Doc Agent Guidance for Working with a User

While the rest of this skill is generic documentation for any Live Doc user, this section is written specifically for you, the LLM agent.

### Copyright and data sharing with LLM services

Authoring Live Docs as an AI agent inherently shares PDF data with third-party LLMs. Unless/until you have confirmed that the user has the right to share the PDF or that the LLM terms prohibit training and data retention, **avoid opening the PDF file, parsing it with another tool, pulling its bytes into context, taking snapshots of the resulting VIZ**, or anything else that might put copyrighted content in LLM context. The `makerchip_extract_pdf_figure` tool can be used to narrow your data sharing. In addition to its other benefits (exposing exactly the VIZ call results and avoiding context clutter), using it with `includePaths=false` (the default) can avoid the inclusion of the figure's own vector geometry, while other aspects of the figure are less sensitive to copyright.

Encourage Live Doc developers to communicate openly with static content authors and to consult legal counsel.

### Preparing to work on a Live Doc

When a user asks you to create a Live Doc, it is important to be clear on a few points. If not already evident, ask questions like:

1. "What are the licensing terms of the original content? Are you the author, or do you have the right to copy it? (If you don't, I will provide overlay and set visual properties without copying elements into the VIZ code, but legal review may be needed.) Are there attribution requirements?" The parenthetical is important for two reasons: 1. it reassures the user that progress can be made without copying content to avoid a false affirmative from a user who fears being blocked; 2. it provides a legal disclaimer. In rare cases, there may even be patent consideration that warrant clarification.

2. "Do you want me to leverage diagram as is or make improvements?" Without legal rights, direct leverage only (by reference) is a necessity. Alternatively, the diagram can be altered entirely to avoid mimicking any of its design. Direct leverage can be important for companion material to maintain a clear connection to the original. If the original is merely an inspirational starting point, it may be better to create a new diagram that is optimal for animation.

3. "How likely it is that subsequent versions of the original diagram will become available?" If uprevving may be necessary, and the original is leveraged by reference, consider the use of filtering features to minimize the likelihood of breaking changes. If copying is an option, mimicking elements as fabric.js code might minimize future maintenance in the face of change.

4. "Is there an existing HDL model providing VCD trace data, or should I create HDL code to drive stimulus? Should the stimulus model use TL-Verilog or something else? Should it be structured to run self-contained in Makerchip or to simulate and generate a VCD externally?"

If the user does not have the rights to the original content, also ask:

"If the PDF is copy-protected, might your LLM provider for this conversation be authorized to train on conversation data or retain it for an extended period? If so, I need to avoid reading the PDF directly. Your LLM settings may provide an option." Ask **before** the first `makerchip_extract_pdf_figure` call, and carefully avoid reading copyright-protected data from the PDF if protected, reporting your limitations rather than risking infringement.

### Addressing hurdles

**Legal considerations must always take precedence**. Never risk copyright infringement. If meeting
goals would impose legal risk, stop, and explain the situation.

### Inspecting a PDF (the `makerchip_extract_pdf_figure` tool)

Before writing Live Doc code, **inspect the PDF** with the `makerchip_extract_pdf_figure` tool. It returns exactly what your `\viz_js` code's `extractFigure` call will see, while keeping the context narrow.

Use it to:

- **Find anchor coordinates** — read `primitives[].bbox` (wire midpoints, figure coordinates) to position overlay chips, which you add to the group `extractToFabric` returns.
- **Choose a `select` mode / cluster index** — try `{mode:"largest"}`, `{mode:"cluster", index:N}`, or a `{mode:"region", rect:[…]}` crop (page coordinates) and see which primitives/labels land in the figure. Pass `pageCoords: true` to read positions in page coordinates, as `select` takes them; leave it off when reading anchors for overlays, which are in figure coordinates.
- **Discover pool indices** — read the `labels` and `primitives` arrays to pick the integer indices you will name in `toFabric`/`extractToFabric`'s `labels`/`primitives` opts.

Tool notes:

- Leave `includePaths` off unless you need exact vector paths: `d` is the drawing itself, not metadata about it.
- For a large figure (hundreds of primitives), start with `summary: true`, which is usually enough to see what the figure is made of. Then pass `outFile: true` and filter the written JSON with `jq` or `python` in the terminal, reading only the records you need. That keeps context small and the rest of the extraction on the user's machine. If the count comes from fragments (curves as scanline slivers, wires as segments), add `group: true` to see wire nets and pieced-together fills as single records, and name a group's runs in `\viz_js` with `{nth: [{from, to}, ...]}`. When filtering, carry `kind` and style forward from earlier primitives, since they appear only where they change.

**Finding a figure by its caption (experimental).** Instead of `select`, pass `caption: "Figure 3.7"`.

- Never write `caption` into `\viz_js` code — hardcode the reported `region` rect, which is a stable runtime selector, and check it selects the figure you meant.
- **Verify the match.** A page's "Figure 3.7" is more often a cross-reference in body prose than a caption, and a running header can match too. The tool reports every candidate; use `captionIndex` to choose another. Measured on real pages: one had only prose mentions, one had three candidates including a case variant, and one had no captions at all.
- **Feedback is wanted on this one.** If it picks the wrong figure, needs a hint it does not have, or the candidate report was not enough to decide, say so — and if you are working against a development build, file it in the extension repo's `issues/`.

Once you understand the figure, write the `\viz_js` code using the API reference below. `extractToFabric` is the entry point; the pool indices you discovered here are what you name in its `build.labels` / `build.primitives`.

---
