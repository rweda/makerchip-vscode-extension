# Changelog

All notable changes to the **Makerchip** extension are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); this project
uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- **Tiny Tapeout.** A "Run TT Flow" button on the `.tlv` design file of a Tiny Tapeout project (in `src/` of a
  project with `info.yaml`, such as one made from
  [tt-makerchip-template](https://github.com/stevehoover/tt-makerchip-template)). It checks the project
  information Tiny Tapeout requires, compiles in Makerchip and, for Tiny Tapeout, with SandPiper-SaaS (no
  install needed), commits and pushes, which runs the flow on GitHub Actions. TT Progress and TT Layout views
  then follow the run.
- An agent skill for setting up a Tiny Tapeout project on GitHub.

### Changed

- Compiling brings the Makerchip panel to the front.
- The "Makerchip Data" workspace folder replaces another Makerchip install's, rather than being added beside it.

### Fixed

- A console error on resizing the Makerchip panel (from resize forwarding that could not work, now removed).
- After a window reload, views whose compile stage had failed (e.g. Waveform and VIZ on a simulation failure)
  showed as still working.

## [0.0.2] — 2026-11-06

### Added

- An agent skill for compiling C, C++, or assembly in Compiler Explorer and running it on WARP-V.

### Changed

- Makerchip "panes" are now **views**, matching common IDE terminology. Tools are renamed
  accordingly: `makerchip_open_view`, `makerchip_get_available_views`, `makerchip_fit_view`,
  `makerchip_open_third_party_view`, and `makerchip_view_call`; layout state uses
  `views`/`activeView`. Servers that predate the rename are still supported.

## [0.0.1] — 2026-10-22

Initial pre-release. Requires the
[TL-Verilog](https://marketplace.visualstudio.com/items?itemName=RedwoodEDA.tlverilog)
extension, which VS Code installs automatically.

### Added

- Compile and simulate TL-Verilog against a Makerchip server, with circuit
  diagrams, waveforms and VIZ rendered in a webview panel. Multi-file designs
  (`m4_include`d files) are supported.
- Multiple named panels, so several designs can be compared side by side.
- GitHub Copilot and Claude Code integrations: Language Model tools that let agents launch
  Makerchip, compile designs and drive the IDE (layout, panes, cycle, highlighting),
  plus an `@makerchip` chat participant. Tools are enabled by activity, to keep
  agents' tool lists short.
- VIZ capture: images, and GIF/MP4/WebM/APNG videos with camera keyframes.
- Live Doc (experimental): animate figures extracted from PDFs with simulation
  data, with copyright safeguards for agent-assisted authoring.
- WARP-V and Compiler Explorer: compile C, C++, or assembly for RISC-V and run it
  on a configurable WARP-V CPU.
- A local compile cache under `~/.vscode-makerchip/`, along with reference
  documentation and examples maintained for AI assistants, and a Makerchip skill
  installed for Claude Code.
- Acceptance of the Makerchip Terms of Service and Privacy Policy before the
  extension contacts any service, asked again when they are revised.
