# 009: SystemVerilog language features inside TL-Verilog

- Status: open
- Area: tlv-extension (language features)
- Created: 2026-09-28

TL-Verilog is a superset of SystemVerilog: `.tlv` files embed SV in `\SV`,
`\SV_plus`, and (via SandPiper output) generated-SV regions. The `tl-verilog`
extension deliberately provides only the TL-Verilog *layer* (semantic
highlighting, M4/M5, pipe signals, stages). It has **no** SV language services
(hover-to-declaration, go-to-definition, completion, formatting, lint).

The previous regex-based hover provider and "Instantiate Module" command
(copied from the SystemVerilog extension) were removed: they were SV-oriented,
not TLV-aware, and low value. This issue tracks doing SV-in-TLV *properly* if we
decide it's worth it.

## Remaining work / options

- **A — Recommend the dedicated SV extension (cheapest).** Point users at
  [`mshr-h.veriloghdl`](https://github.com/mshr-h/vscode-verilog-hdl-support) for
  SV work (README note and/or `extensionPack`/recommendation). Caveat: VS Code
  registers providers per `languageId`, so that extension's providers will *not*
  automatically run on embedded SV ranges inside a `.tlv` document.
- **B — Embedded language + SV language server (the "proper" superset).** Host or
  reuse an SV LSP (svls, verible, or similar) and forward requests scoped to the
  SV regions of the `.tlv` file — either via request-forwarding middleware, or by
  mapping through SandPiper's TLV→SV output back to source lines. This is the only
  path that yields correct results for SV embedded in TLV. Non-trivial; needs a
  design spike (region detection, position mapping, web-host constraints).

## Decision needed

Whether SV-in-TLV is worth building at all, given Makerchip already handles
compilation/simulation. If not, close as `wontfix` after adding the Option A
README pointer.
