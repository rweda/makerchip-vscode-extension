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

Authoring Live Docs as an AI agent inherently shares PDF data with third-party LLMs. Unless/until you have confirmed that the user has the right to share the PDF or that the LLM terms prohibit training and data retention, **avoid opening the PDF file, parsing it with another tool, or pulling its bytes into context.** The `makerchip_extract_pdf_figure` tool can be used to narrow your data sharing. In addition to its other benefits (exposing exactly the VIZ call results and avoiding context clutter), using it with `includePaths=false` (the default) can avoid the inclusion of the figure's own vector geometry, while other aspects of the figure are less sensitive to copyright.

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

Before writing Live Doc code, **inspect the PDF** with the `makerchip_extract_pdf_figure` tool. It runs the *exact same* `this.global.pdf.extractFigure(source, opts)` that your `\viz_js` VIZ code will use at runtime, so the coordinates, labels, cluster selection, figure bbox, and coordinate `transforms` it returns match precisely what your VIZ overlay will see — no drift between what you inspect and what runs. Additionally, it provides narrower results to avoid clutter and potentially-copyrighted data in the context window.

Use it to:

- **Find anchor coordinates** — read `primitives[].bbox` (wire midpoints) to place overlay chips with `fig(...)`.
- **Choose a `select` mode / cluster index** — try `{mode:"largest"}`, `{mode:"cluster", index:N}`, or a `{mode:"region", rect:[…], space:"device"}` crop and see which primitives/labels land in the figure.
- **Discover pool indices** — read the `labels` and `primitives` arrays to pick the integer indices you will name in `toFabric`/`extractToFabric`'s `labels`/`primitives` opts.
- **Read the coordinate `transforms`** for manual coordinate conversion.

Tool notes:

- `source` must be a **URL reachable from the Makerchip IDE** (fetched through its CORS proxy, exactly like `\viz_js`). Local files must be served at a URL (e.g. mono serves `ide-env/public/` at `/module/ide/`, so a file in `ide-env/public/tmp/foo.pdf` is reachable at `/module/ide/tmp/foo.pdf`).
- Requires an **open Makerchip panel** (extraction runs in the IDE browser context). It does **not** require a compiled design or simulation data.
- SVG path `d` strings are omitted by default. That keeps the result compact, and it also keeps the figure's own geometry out of model context — `d` is the drawing itself, not metadata about it. Set `includePaths: true` only when you actually need exact vector paths, and never copy the returned `d` strings into `.tlv` source (see the copyright model above).
- The tool inputs mirror `extractFigure`'s `opts`: `page`, `select`, `gap`, `space`, `text`, `clip`.

Once you understand the figure, write the `\viz_js` code using the API reference above.

---
