# Changelog

All notable changes to the **Makerchip** extension are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); this project
uses [semantic versioning](https://semver.org/).

## [0.0.1] — unreleased

Initial pre-release. Requires the
[TL-Verilog](https://marketplace.visualstudio.com/items?itemName=redwood-eda.tl-verilog)
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
