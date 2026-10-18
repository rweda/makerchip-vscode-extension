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

Authoring a Live Doc as an AI agent shares PDF content with your LLM provider. DO NOT EXTRACT PDF DATA FOR AUTHORING A LIVE DOC UNLESS/UNTIL THE USER ATTESTS TO THEIR RIGHTS through their response to the copy question (question 1 below). Until authorized, do NOT provide a `clearance` argument to tools. Do not open, parse or otherwise read the PDF any other way, and do not capture the VIZ while it shows the PDF's content. What each answer permits:

| Answer | Tool content | VIZ captures | Files for the user | Copies of content into `.tlv` |
|---|---|---|---|---|
| `copy`: they may copy the content | yes | yes | yes | yes |
| `chat`: their LLM provider neither retains nor trains on this conversation | yes | returned to you only | no | no |
| neither | document information only | no | no | no |

A PDF whose permissions deny copying is "neither" whatever the answer: the tool enforces this, and you must not capture a VIZ built from it. Temp files the tool writes are exempt, but what you read from them counts as shared.

The built VIZ draws the document's copyright notice below the figure by default (see `build.notice`). If the tool found none, pass the user's terms (question 2 below) as `build.notice`. Remove it (`build.notice: false`) only on the user's word that it is not required.

Encourage Live Doc developers to communicate openly with static content authors and to consult legal counsel.

### Preparing to work on a Live Doc

When a user asks you to create a Live Doc, it is important to be clear on a few points. First, call `makerchip_extract_pdf_figure` without `clearance`: it then returns only document information (title, pages, permissions, copyright notice). If the permissions deny copying, tell the user you cannot author a Live Doc from this PDF, and stop. If the copyright notice is successfully extracted, you may simplify/reframe the questions and guidance below accordingly.

Share pertinent document information with the user, and prepare them for a stream of questions, e.g.:

> "Before authoring a Live Doc, it is important to clarify your goals and constraints, especially regarding copyright and data sharing. If the copyright terms permit copying, things are easy. If not, I will do my best to avoid copying content into the `.tlv` code, instead referencing the PDF and extracting its content when the VIZ runs. But I'm not perfect, so oversight and legal review are highly recommended, and compliance is ultimately up to you, so continue at your own risk. In addition, authorship requires me to exchange data with your LLM provider. You may need to disable any data retention and LLM training settings. Without your authorization to share the PDF data with your LLM provider, I will be unable to author a Live Doc."

Ask (through your question UI if you have one) questions like:

1. The copy question (always ask; if the extracted notice clearly permits copying, suggest option 1 for the user to confirm): "As discussed above, do the copyright terms: 1. permit copying the PDF's content; 2. not permit copying, but my LLM provider neither retains nor trains on this conversation (check your settings); 3. neither, so we will not author a Live Doc for this PDF?" Options 1 and 2 grant `clearance` `copy` and `chat`; option 3 grants none.

2. (Skip if the extracted notice states the terms.) "Do the copyright terms require attribution? If so, what are the specific terms?"

3. "Do you want me to leverage the diagram(s) as they are or reimagine them?" Without copy rights, either use the diagram by reference or design a new one that doesn't mimic it. Direct leverage can be important for companion material to maintain a clear connection to the original. If the original is merely an inspirational starting point, it may be better to create new diagrams that are optimal for animation.

4. "How likely is it that subsequent versions of the original diagram will become available?" If uprevving may be necessary, and the original is leveraged by reference, consider the use of filtering features to minimize the likelihood of breaking changes. If copying is an option, mimicking elements as fabric.js code might minimize future maintenance in the face of change.

5. "Is there an existing HDL model providing VCD trace data, or should I create HDL code to drive stimulus? Should the stimulus model use TL-Verilog or something else? Should it be structured to run self-contained in Makerchip or to simulate and generate a VCD externally?"

Subsequently, pass the `clearance` the user's answer grants; never assume it.

### Addressing hurdles

**Legal considerations must always take precedence**. Never risk copyright infringement. If meeting
goals would impose legal risk, stop, and explain the situation.

### Inspecting a PDF (the `makerchip_extract_pdf_figure` tool)

Before writing Live Doc code, and once cleared (above), **inspect the PDF** with the `makerchip_extract_pdf_figure` tool. It returns exactly what your `\viz_js` code's `extractFigure` call will see, while keeping the context narrow.

Use it to:

- **Find anchor coordinates** — read `primitives[].bbox` (wire midpoints, figure coordinates) to position overlay chips, which you add to the group `extractToFabric` returns.
- **Choose a `select` mode / cluster index** — `summary: true` previews an extraction compactly. To find a figure on a page, survey it first with `select: {mode:"all"}, text: "all", summary: true`: the page's clusters and largest primitives (page coordinates, as `select` takes them), and the selection's rows, image boxes and text lines (figure coordinates, as records and overlays use them; add the figure box's origin for page coordinates). Then try `{mode:"largest"}`, `{mode:"cluster", index:N}`, or a `{mode:"region", rect:[…]}` crop and see which primitives/labels land in the figure.
- **Discover pool indices** — read the `labels` and `primitives` arrays to pick the integer indices you will name in `toFabric`/`extractToFabric`'s `labels`/`primitives` opts. `render: {annotate: true}` shows each id on the figure.

Tool notes:

- Leave `includePaths` off unless you need exact vector paths: `d` strings are large.
- `render: true` returns the figure as pdf.js draws it. Compare it with a VIZ image of your build to catch what extraction lost or changed (fonts, text, layering). Add `extraction: false` for the image alone.
- For a large figure (hundreds of primitives), pass `summary: true, extraction: {file: true}`: the summary, usually enough to see what the figure is made of, comes back in context, and the records go to a temp file. Filter that JSON with `jq` or `python` in the terminal, reading only the records you need. If the count comes from fragments (curves as scanline slivers, wires as segments), add `group: true` to see wire nets and pieced-together fills as single records, and name a group's runs in `\viz_js` with `{nth: [{from, to}, ...]}`. When filtering, carry `kind` and style forward from earlier primitives, since they appear only where they change.

**Finding a figure by its caption (experimental).** Instead of `select`, pass `caption: "Figure 3.7"`.

- Never write `caption` into `\viz_js` code — hardcode the reported `region` rect, which is a stable runtime selector, and check it selects the figure you meant.
- **Verify the match.** A page's "Figure 3.7" is more often a cross-reference in body prose than a caption, and a running header can match too. The tool reports every candidate; use `captionIndex` to choose another. Measured on real pages: one had only prose mentions, one had three candidates including a case variant, and one had no captions at all.
- **Feedback is wanted on this one.** If it picks the wrong figure, needs a hint it does not have, or the candidate report was not enough to decide, say so — and if you are working against a development build, file it in the extension repo's `issues/`.

Once you understand the figure, write the `\viz_js` code using the API reference below. `extractToFabric` is the entry point; the pool indices you discovered here are what you name in its `build.labels` / `build.primitives`.

---
