# Changelog

All notable changes to the **Makerchip** extension are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); this project
uses [semantic versioning](https://semver.org/).

## [0.0.1] — unreleased

Initial release. Requires the
[TL-Verilog](https://marketplace.visualstudio.com/items?itemName=redwood-eda.tl-verilog)
extension, which VS Code installs automatically.

### Added

- Compile and simulate TL-Verilog against a Makerchip server, with circuit
  diagrams, waveforms and VIZ rendered in a webview panel.
- Multiple named panels, so several designs can be compared side by side.
- GitHub Copilot and Claude Code integrations: Language Model tools that let agents launch
  Makerchip, compile designs and drive the IDE, plus an `@makerchip` chat
  participant.
- A local compile cache under `~/.vscode-makerchip/`, along with reference
  documentation and examples maintained as RAG data for AI assistants.
