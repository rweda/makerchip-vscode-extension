# 025: Feedback from first test drive

## Prompt

Help me test the Makerchip exension's Tiny Tapeout support. Create a simple, but interesting and unique 1x1 SKY130 submission.

Record any findings that would help to improve the extension in `Tiny Tapeout Testing.md`.

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
