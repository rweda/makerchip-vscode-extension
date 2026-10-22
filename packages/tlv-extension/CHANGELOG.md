# Changelog

All notable changes to the **TL-Verilog** extension are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); this project
uses [semantic versioning](https://semver.org/).

## [0.0.1] — 2026-10-22

First release published by Redwood EDA, as `RedwoodEDA.tlverilog`. It succeeds
the original [TL Verilog](https://marketplace.visualstudio.com/items?itemName=Dmytro.TL-Verilog)
extension (`Dmytro.TL-Verilog`), and is developed in the
[`makerchip-vscode-extension`](https://github.com/rweda/makerchip-vscode-extension)
monorepo alongside the Makerchip extension.

### Added

- Semantic highlighting for TL-Verilog, with custom token types covering pipe
  signals, behavioral and physical hierarchy, pipelines, stages, `when`
  conditions, alignment operators, constants, attributes, and M4/M5 macros.
  Toggle with `tlverilog.semanticHighlighting.enabled`.
- The standard TL-Verilog color scheme, applied over whatever theme the user
  already has (including a dark-theme variant) rather than requiring a
  dedicated color theme.
- Web extension support, so the language features work in vscode.dev and
  github.dev as well as on the desktop.
- `tlverilog.experimentalFeatures` setting, gating an experimental Waveform
  toolbar button (off by default).

### Changed

- The TextMate grammar and language configuration now come from the shared
  [`@rweda/tlv-grammar`](https://github.com/rweda/makerchip-vscode-extension/tree/main/packages/tlv-grammar)
  package, so the same grammar can be reused by Monaco, Shiki and GitHub
  Linguist.

### Removed

- The regex-based hover provider and the "Instantiate Module" command carried
  over from the original SystemVerilog extension. Both were SystemVerilog-
  oriented rather than TL-Verilog aware (e.g. the hover ignored pipe signals
  like `$sig`, and instantiation emitted plain SV syntax). For SystemVerilog
  editing features, install a dedicated SystemVerilog extension such as
  [Verilog-HDL/SystemVerilog](https://github.com/mshr-h/vscode-verilog-hdl-support).
