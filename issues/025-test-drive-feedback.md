# 025: Feedback from first test drive

## Prompt

Help me test the Makerchip exension's Tiny Tapeout support. Create a simple, but interesting and unique 1x1 SKY130 submission.

Record any findings that would help to improve the extension in `Tiny Tapeout Testing.md`.

## Found in Earlier Testing

Recovered from the earlier ("Wolfram Ring") agent's report, `~/repos/makerchip-extension-findings.md`.

E1. **Apply a minimum hold for quick results in the extension (high).** The skill's workaround for the
    harness race (a quick call's result dropped during approval, wedging the call) depends on the agent
    correctly predicting which calls are quick. That agent called `makerchip_list_panels` directly and wedged
    it. Suggest: the extension holds every tool's result (or every known-fast tool's) for a floor of ~2-3 s,
    keeping `minDurationMs` as an override. Re-check whether the harness has fixed the race first.

## Session: "Hailstone" (2026-11-10)

Design: **Hailstone**, a Collatz-sequence flight recorder (`tt_um_stevehoover_hailstone`, sky130A, 1x1,
https://github.com/stevehoover/tt-hailstone). `ui_in` = seed (0 means 256); one Collatz step per clock; the 7-seg
shows the altitude (floor(log2(value)), hex) in flight, then the peak altitude with the decimal point lit once it
lands at 1; `uio_out` = step count. The VIZ plots the trajectory (log scale) on the demo board's chip.

Result: the first push via "Run TT Flow" passed `test`, `docs`, and `gds` (including `precheck`, `gl_test` and
`viewer`), at 23% utilization.

## Findings

### Setup / skill (`tiny-tapeout.md`)

2. **The template's initial commit starts `gds`/`test`/`docs` before Pages can be enabled** (step 3 runs a few
   seconds later). That's harmless, since the skill expects those runs to fail anyway, but the first run's
   `viewer` job can't deploy.

### "Run TT Flow" button (installed `redwoodeda.makerchip-0.0.3/out/tinyTapeout.js`)

The button's checks (and any for 8) are a first filter; CI is the real check. They should stay advisory, as they
are today ("Push Anyway"), and never block a push on a false positive.

8. **Pre-push checks don't cover the testbench.** Per the skill, the template's `test/test.py` fails as soon as
   the design drives outputs. Possible advisory warning: `test/test.py` unchanged from the template. Optionally,
   offer to run `cd test && make` locally when `cocotb-config` and `iverilog` are available. Locally the
   Hailstone cocotb test took ~2 s, versus a CI round trip.
9. **Two ways to regenerate `project.sv`.** The button POSTs to `faas.makerchip.com` directly; the template's
   `make verilog` uses the `sandpiper-saas` CLI. Their outputs were identical this session (apart from trailing
   whitespace), but nothing keeps the two flag sets in sync. Worth a shared definition or a test.

### Template (`tt-makerchip-template`)

10. **`clock_hz` gets no guidance.** For a human-paced design (watched at a few Hz) it's unclear whether to put
    0, the intended rate, or the max. A comment in `info.yaml`, or a line in the skill, would help.

### Makerchip tools / VIZ

11. **A design's VIZ is tiny in the TT demo board, and the skill doesn't say where it is.** `\viz_js` in
    `my_design()` is fit into the board's chip window, so a whole-board `makerchip_get_viz_image` makes it
    unreadable. I estimated the chip's position from a keyframe and zoomed with a 1-frame
    `makerchip_capture_video`.
    - **Where the geometry is defined:** Virtual-FPGA-Lab `tlv_lib/fpga_includes.tlv`, the `BOARD_7_*`
      `universal_vars` ("Tiny Tapeout (Motherboard v2.1)", ~line 110; commit b31497e). It's included by
      `tlv_lib/tiny_tapeout_lib.tlv` (commit 62d6e18), which the template includes; the template uses board 7
      via `m5+board(/top, /fpga, 7, $, , my_design)`.
    - **Coordinates for the current board** (in board-image pixels; the image is
      `tt3demoboardwFPGAcarrier2.jpg`, 2600x2044):
      - chip window (`BOARD_7_FPGA_WHERE`): `left: 1221, top: 898, width: 142, height: 142`, with contents
        centered (`FPGA_WHERE_COMMON`: `justifyX/Y: "center"`)
      - 7-seg (`BOARD_7_SSEG_WHERE`): `left: 1846, top: 1088, scale: 3.36`
      - switches (`BOARD_7_SWITCH_WHERE`): `left: 611, top: 426, scale: 2.9, angle: 90`
    - **Camera keyframe I used**, which depends on the panel size and fit: VIZ ~356x616 at fit scale 0.593; chip at
      `focus: {x: 3, y: -34}, scale: 7`. Board coordinates are the more reliable source.
    - **These will change.** The current board image is old; a new board will have different coordinates. So the
      skill should point to where they are defined (above) rather than hard-code them.
12. **`makerchip_capture_video` with `mode: "absolute"` silently ignored the keyframe's `width`/`height`**
    (600x400 requested; the output had the panel's aspect, 853x1478). This may be by design (size comes from
    `default`), but a warning would help.
13. **A compile with `dot: false` leaves the user's Diagram view showing a bare "none" status**, which reads as a
    failure until the next compile. The tool description now steers agents away from `dot: false` in a panel the
    user is watching. A fuller fix is in the IDE: label it, e.g. "Diagram not generated for this compile", ideally
    with a "Generate" action.
