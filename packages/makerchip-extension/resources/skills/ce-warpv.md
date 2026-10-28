---
name: ce-warpv
description: 'Compile C, C++, Fortran, or RISC-V assembly in Compiler Explorer and run it on a WARP-V RISC-V core in Makerchip. Use when: running software on WARP-V, "C to CPU", Compiler Explorer (CE), configuring a WARP-V core, checking whether a program passes on WARP-V, or debugging the CE/WARP-V panes.'
user-invocable: true
---

# Compiler Explorer → WARP-V

Compiler Explorer (CE) compiles a program to rv32 assembly. The WARP-V configurator (warp-v.org) turns that assembly
plus a core configuration into TL-Verilog and compiles and simulates it in the Makerchip panel. Both run as
third-party panes connected by the pane bus (CE produces `sourceAsm`; WARP-V subscribes).

Enable the tools first: `makerchip_enable_tools` with target `cewarpv`. Parameters, defaults, and constraints are in
each tool's description; this skill covers the workflow.

## Running a program

- **Agent path:** `makerchip_ce_compile` compiles through the CE HTTP API (no CE pane needed). With
  `deliverToWarpV: true` it also delivers the assembly to the WARP-V pane (opening it if needed) and returns the
  Makerchip compile id. Then `makerchip_wait_compile` gives pass/fail. Use `makerchip_get_viz_image` to look at the core.
- **Human path:** the RISC-V course in the Courses pane has a "C to CPU" demo (`IDE.openWarpVDemo` in mono
  `ide-env/coffee/IDE.coffee`) that opens CE with a sample program. The user clicks "Run on WARP-V" in CE.

## Pass/fail convention

When the assembly has an entry symbol (`main`, or what CE detects for the language), WARP-V prepends a crt0
preamble that sets `sp`, calls the entry, and jumps to `pass:` if `a0 == 0`, otherwise `fail:`. So **the entry
returns 0 for pass**. The simulation also fails at the testbench cycle limit (200 cycles, `default_makerchip_tb` in
warp-v `warp-v.tlv`), so keep test programs short. Sources: crt0 in `m5_assemble` (warp-v_includes
`risc-v_defs.tlv`); `*passed`/`*failed` hookup near the end of `warp-v.tlv`.

## Language notes

- Target rv32i (`-march=rv32i -mabi=ilp32`, the default). No libc, no I/O, no multiply/divide unless the core is
  configured with the M extension and the flags match.
- **Fortran:** entry is `MAIN__`; a runtime shim maps `STOP n` to pass (0) or fail. Any I/O fails to assemble.
- **Entry override** (`entry` arg, or the configurator's "Entry" field) names another function whose integer return
  drives pass/fail, e.g. gfortran's `chk_`.
- Rust is not supported.
- Hand-written assembly with no entry must define its own `reset:` (and `pass:`/`fail:` labels for pass/fail).

## Configuring the core

- `makerchip_get_warpv_config` returns `{general, pipeline, programText}`; `makerchip_set_warpv_config` merges
  changes and reports `{applied, rejected}`.
- Set `general.depth` in its own earlier call: it re-derives the pipeline stages, overwriting pipeline changes made
  in the same call.
- A custom program needs both `programText` and `customProgramEnabled: true`.
- Cross-field validity is only checked by compiling, so always follow a config change with a compile and
  `makerchip_wait_compile`.
- `makerchip_get_warpv_tlv` returns the generated TL-Verilog, e.g. to save or edit it outside the configurator.

## Source tracking in VIZ

For CE programs, the "Instr. Memory" VIZ shows the original source next to each instruction and highlights the line
of the executing instruction (`ce_source_viz_data`, built by `buildCeSourceViz` in the configurator's
`Translation.js`).

## Local development

- `makerchip_ce_compile` `warpvUrl` must be HTTPS (an http URL is blocked as mixed content); use a tunnel (e.g. cloudflared) for a
  local configurator. `ceOrigin` selects the CE instance.
- In the IDE, `?local_ce[=port]` (default 10240) and `?local_warpv[=port]` (default 3009) make the demo frame local
  servers.
- Set `general.warpVVersion` to a URL to build against a local or forked `warp-v.tlv`.
- For generic bus/RPC debugging, `makerchip_pane_call` and `makerchip_emit` reach the panes directly (protocol in
  `Makerchip-public/docs/plugin_api/Third_Party_Pane_API.md`).
