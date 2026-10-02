# Live Doc Feedback from Yashvini

Yashvini is using an early version of Live Doc to create companion materials for Hennessy and Patterson.

She provided this feedback:

# Yashvini:

I have created this file for Agent to decrease the chance of them failing or if they get confused, so to prevent them from getting lost in side quests. This is based on my own experiences with livedoc, the problems agent faced and the solution for them. I'm sending this just in case if you might be interested in taking a look

# How to extract a diagram from a big PDF for Makerchip Live Doc VIZ

Concise recipe. Follow steps in order. Don't skip verification steps — they catch
90% of failures before you waste time debugging `.tlv` compiles.

## 0. Constraint

Live Doc's PDF fetch has a **10MB limit**. Big textbooks exceed it, so split out
just the target page into its own tiny PDF first.

## 1. Split out the target page (pikepdf)

```python
import pikepdf
src = pikepdf.open(r"<path to big source pdf>")
dst = pikepdf.new()
dst.pages.append(src.pages[N - 1])   # 0-based index; N = 1-based page number you want
dst.save(r"<output dir>/pageN.pdf")
```
Run with a python that has `pikepdf` installed. Output is normally tens of KB — well
under the limit.

## 2. Serve it locally with CORS + range-request support

Live Doc's `fetch` needs `Access-Control-Allow-Origin: *` and range support (pdf.js
uses range requests). Reuse `cors_server.py`:
```python
import http.server, os
from RangeHTTPServer import RangeRequestHandler
class CORSRangeRequestHandler(RangeRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()
os.chdir(r"<dir containing pageN.pdf>")
http.server.test(HandlerClass=CORSRangeRequestHandler, port=8123)
```
Run it (`python cors_server.py`), leave it running in the background.

## 3. Expose it publicly with a cloudflared quick tunnel

The Makerchip IDE runs in a browser and can't reach `localhost`, so tunnel it:
```powershell
cloudflared tunnel --url http://localhost:8123
```
Watch the output for the assigned URL:
```
https://<random-words>.trycloudflare.com
```
**A new random URL is issued every time you restart cloudflared** — there's no way to
pin it without a paid/named tunnel + owned domain. Verify it works before using it:
```powershell
curl.exe -s -o NUL -w "%{http_code}" https://<url>/pageN.pdf   # must be 200
```
Quick tunnels can die silently if idle (DNS stops resolving) — re-verify with curl
before every session, not just once.

## 4. Inspect the figure before writing any viz_js

Use the `makerchip_extract_pdf_figure` tool (requires an open Makerchip panel) with:
```json
{"source": "https://<url>/pageN.pdf", "page": 1, "select": {"mode": "largest"}}
```
This runs the exact same extraction `buildFigure` will use at runtime. Read the
returned `labels[]` (text + x/y in figure space) and `primitives[].bbox` to find
coordinates for anchoring overlay elements (e.g. wire-value "bubbles"). Confirm the
labels match the figure you expect (e.g. by name) before proceeding.

**If the page contains more than one diagram/figure (e.g. "Figure N.NN" captions for
multiple figures, or several distinct clusters of primitives) and the user hasn't
already told you which one they want, STOP and ask them to confirm which figure
(by number/caption/description) before picking a rect or writing any `.tlv` code.**
Don't guess based on "largest" or first-found — list the figure captions/labels you
see on the page and let the user choose.

## 4b. Tune the crop region (so page text doesn't come along)

Problem: sometimes `mode:"largest"` keeps every label inside the rect, so a sloppy rect
pulls in paragraph text, captions and page numbers. Don't guess a rect. Measure it.

1. Extract with `{"select": {"mode": "largest"}, "space": "device", "text": "all"}`.
2. Read `ext.bbox.device` = [x0, y0, x1, y1]. This is the tight box around the
   diagram's vector primitives. Use it as the rect, padded by ~6px per side:
   rect = [x0-6, y0-6, x1+6, y1+6]
3. Re-extract with `{"select": {"mode":"region","rect":[...],"space":"device"}, "clip": true}`.
4. Verify `labels[]`:
   - Only short diagram symbols should remain (A, B, C, Y, gate names).
   - If a long sentence or caption remains, its x/y tells you which edge to
     pull in. Move that edge of the rect past the label's y (or x) until gone.
   - If a diagram label is missing or a gate/arrow is clipped, widen that edge
     by 4-6px.
5. Repeat 3-4 at most 3 times, then stop and report the final rect.

Notes:
- Always use `clip: true` with region, or full-page background rects sneak in.
- Labels are dropped by position, not meaning. Text touching the diagram
  (e.g. a caption directly under it) needs a tight edge, not a clever filter.
- If you animate by overlaying your own value chips, you can use `text: "none"`
  and skip label cleanup entirely. Cost: the diagram's own A/B/C text is gone too.
- Primitive indices change whenever the rect or page changes. Do all index
  discovery AFTER the rect is final.

## 5. Write the `.tlv` file

Minimal skeleton (static extraction check, no animation yet):
```
\m5_TLV_version 1d: tl-x.org
\m5
   use(m5-1.0)
\SV
   m5_makerchip_module
\TLV
   $reset = *reset;

   \viz_js
      box: {left: 0, top: 0, width: 460, height: 340, fill: "#ffffff"},

      init() {
         let widgets = {}
         let figure = new fabric.Group([], {originX: "left", originY: "top", selectable: false, evented: false})
         widgets.figure = figure

         const PDF_URL = "https://<url>/pageN.pdf"
         this.global.pdf.buildFigure(fabric, {url: PDF_URL}, {
            page: 1, select: {mode: "largest"}, clip: true,
            left: 4, top: 16, into: figure
         }).then(() => { this.getCanvas().requestRenderAll() })

         return widgets
      },

      render() { return [] }
\SV
   endmodule
```

### Gotchas (each of these breaks the compile or silently renders garbage)

- **Must end with `\SV` / `endmodule` after the `\viz_js` block.** Omitting it makes
  SandPiper silently emit a truncated `top.sv` (exit code 0!) and Verilator then fails
  with a confusing "syntax error, unexpected end of file" pointing at an unrelated
  line. If you hit that error, pass `fetchIntermediateFiles: true` to
  `makerchip_compile`/`makerchip_wait_compile` and check `top.sv` for a missing
  `endmodule`.
- **No backticks (template literals) inside `\viz_js`.** M4/M5 uses backtick+quote
  as its own quoting syntax. Build strings with `+` concatenation instead.
- **Single-quoted strings are TLV signal syntax** (`'$sig'.asInt()`), not JS strings.
  Use double quotes for any literal string (colors, labels, etc.).
- **Adding NEW fabric objects after `init()` has returned is unreliable** (needed for
  anything positioned from the async `buildFigure` result, e.g. per-cycle value
  bubbles). Two things that silently misplace objects:
  - `this.getCanvas().add(obj)` — adds to the global canvas, not this box's local
    coordinate frame.
  - `someGroup.addWithUpdate(obj)` (e.g. the `figure` group) — Fabric recomputes the
    group's bounding box on every add, shifting all existing children.
  Fix: create every dynamic object **synchronously in `init()`** at a placeholder
  position (e.g. `left: -100`) and return it via `widgets` so the framework registers
  it correctly. Once `buildFigure`'s `.then(({fig}) => ...)` resolves with real
  coordinates, just `.set({left, top})` on the already-registered object to move it
  into place — repositioning works fine, only late *additions* don't.
  Use `fig(x, y)` (returned by `buildFigure`/`toFabric`) to convert the figure-space
  coordinates you read in step 4 into this box's placement space.

## 6. Compile and verify visually

```
makerchip_compile(filePath, oneShot: true)
makerchip_get_viz_image()   # inspect the rendered PNG
```
If `verilator` exit status != 0, fetch intermediate files and check `top.sv`/`top.m4`
before guessing at the `.tlv` source.


# Yashvini:

You might want to use this for your own agent or even can check if these things are correct or not using Opus. I'll try this on my side as well in different sessions to see if it's good for almost every agent or nah

this md file is kind of "recipe to follow" for agents lol

ahhh i just made the short one as well with help of Claude.

# Live Doc: animate a PDF diagram in Makerchip (agent recipe)

Follow in order. Never guess a number you can measure. After 3 failed
attempts at any step, STOP and report what you saw.

## A. Setup (human or agent)
1. Extract the one page: pikepdf, dst.pages.append(src.pages[N-1]),
   save as pageN.pdf. (Fetch limit is 10MB, so never use the whole book.)
2. Serve it with CORS + range support (cors_server.py, port 8123).
3. Tunnel it: cloudflared tunnel --url http://localhost:8123.
   The URL changes on every restart and dies when idle.
   Check it with curl -s -o NUL -w "%{http_code}" <url>/pageN.pdf (must be 200).

## B. Pick the figure and crop
1. Extract with makerchip_extract_pdf_figure:
   {"source":"<url>","page":1,"select":{"mode":"largest"},"space":"device","text":"all"}
2. If the page has several figures and the user did not name one, STOP and ask.
3. Crop rect = ext.bbox.device padded 6px: [x0-6, y0-6, x1+6, y1+6].
   Use mode:"region", space:"device", clip:true.
4. Check labels[]: only short diagram symbols (A, B, Y...) should remain.
   A sentence or caption means pull that edge in. A clipped gate means widen
   it by 4-6px. At most 3 tries.
5. FREEZE page and rect now. Changing either shifts every index and coordinate.

## C. Choose the animation method
Dump once: console.log("N", res.ext.primitives.length) and the bboxes.
- N large and each bbox is one wire: name primitives with
  primitives:{sig:[idx,...]} and recolor them.
- N small (~15) or a bbox spans several wires (the wires are merged): use
  overlay lines (D). Indices cannot isolate a wire.

## D. Overlay lines
Start from livedoc_overlay_template.tlv. Edit ONLY:
- PDF_URL, the crop rect, SEGS, DX/DY, and the signal reads in render().
- Do NOT touch the engine (init/_paint/.then structure).

Steps:
1. Write SEGS = {sig: [[x1,y1,x2,y2], ...]} in figure space, estimated from
   the bboxes (a rail is the left/right edge of a tall bbox).
2. Set ALIGN = true. Every line shows in BLUE (calibration only).
   Fix a uniform offset with DX/DY, and local errors in single segments.
   Step 0.5.
3. Stop when no black wire is visible beside the overlay at normal zoom.
   Do not chase sub-unit differences.
4. Set ALIGN = false. Orange now appears only while that signal is 1.

## E. Rules that prevent silent failures
- The file must end with \SV / endmodule after \viz_js. Without it
  Verilator reports a bogus "unexpected end of file". If you see it,
  compile with fetchIntermediateFiles and check top.sv.
- No backticks inside \viz_js. Use double quotes for all strings.
  Single quotes are only for '$sig'.asInt(0).
- Create every fabric object synchronously in init(), hidden, and return it.
  Objects added after init() get misplaced.
- Position objects only inside buildFigure().then(), using res.fig(x,y),
  then call setCoords().
- render() builds _state and calls _paint(). _paint() guards on
  (_ready && _state) and only toggles visibility.
- Inputs are read-only in VIZ. To fix an input, hardcode it ($aa = 1'b1;)
  or use a counter. Use $rand or a counter to sweep.
- Line width is 1 (the diagram's wires are ~0.5). Use the WIDTH constant.

## F. Agent budget
- Small edits only, never rewrite the file.
- One compile per change. Test with frozen inputs before sweeping.
- Report the final rect, DX/DY and SEGS to the user.


# So:

I believe much of this has already been addressed, but look through it and extract anything worth further consideration, then address issues.
