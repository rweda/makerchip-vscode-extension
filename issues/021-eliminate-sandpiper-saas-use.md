# 021: Eliminate the need for SandPiper-SaaS in the TT flow

- Status: open
- Area: platform independence
- Created: 2026-09-09

The "Run TT Flow" button (`src/tinyTapeout.ts`, `compileForTt`) no longer needs any install: it calls
SandPiper-SaaS's JSON API directly. What remains:

- The manual path, `cd test && make verilog` in the Tiny Tapeout template, still needs
  `pipx install sandpiper-saas`.
- Both paths depend on the SandPiper-SaaS service being up. Compiling through the connected Makerchip server
  instead (with TT's flags and without `MAKERCHIP`) would remove that dependency for the button, and would
  also work for Makerchip in the browser.
