---
name: tlv-ecosystem
description: 'TL-Verilog ecosystem guidance. Use when: working with TL-Verilog, TLV, Transaction-Level Verilog, SandPiper, Makerchip IDE, M5 macros, Visual Debug, VIZ, hardware design, digital circuits, digital logic, pipelines, RISC-V, SystemVerilog, circuit visualization, waveform debugging, or asking about TLV syntax, compilation, or tools.'
applyTo:
  - "**/*.tlv"
  - "**/*.sv"
  - "**/*.v"
  - "**/*.m5"
user-invocable: true
---

# TL-Verilog Ecosystem Guide

This skill provides comprehensive guidance for working with Transaction-Level Verilog (TL-Verilog) and its ecosystem of tools.

## Technology Overview

**TL-Verilog (Transaction-Level Verilog)** is a hardware description language that extends SystemVerilog with powerful transaction-level abstractions for digital circuit design. It dramatically simplifies pipeline design, timing, and hierarchy.

**Key Technologies:**

- **TL-Verilog**: The core language with pipeline, hierarchy, and transaction-level constructs
- **M5**: A text macro processor integrated with TL-Verilog for code generation and parameterization
- **Visual Debug (VIZ)**: Graphical visualization capabilities for debugging circuit behavior
- **Makerchip**: Web-based IDE for TL-Verilog development with integrated compilation, simulation, and visualization
- **SandPiper**: The TL-Verilog compiler that generates standard Verilog/SystemVerilog

## How They Work Together

1. **Write code** in `.tlv` files using TL-Verilog syntax
2. **Use M5 macros** for parameterization and code generation (processed before TL-Verilog compilation)
3. **Add VIZ annotations** to visualize circuit behavior during simulation
4. **Compile in Makerchip** (or via SandPiper) to generate Verilog
5. **Simulate and debug** with integrated waveform viewer and Visual Debug graphics

## Language Recognition

TL-Verilog files use `.tlv` extension and combine:
- Standard Verilog/SystemVerilog syntax
- TL-Verilog constructs: `|pipe`, `@stage`, `$signal`, `/hierarchy`, `?$condition`
- M5 macros: `m5_define`, `m5_if`, `m5_for`, etc.
- VIZ annotations: `\viz`, visualization commands

## Documentation References

When helping with TL-Verilog, **reference these primary sources** in the Makerchip resources folder:

### README
- `resources/README.md` - Overview of all resources, documentation, examples, and courses available for TL-Verilog and Makerchip

### Specifications
- **[Makerchip-public/docs/TLXSpec.pdf](../Makerchip-public/docs/TLXSpec.pdf)** - Complete TL-X language specification (authoritative reference)
- **[Makerchip-public/docs/M5_spec.pdf](../Makerchip-public/docs/M5_spec.pdf)** - M5 macro processor language specification
- **[Makerchip-public/docs/VisualDebugUsersGuide.pdf](../Makerchip-public/docs/VisualDebugUsersGuide.pdf)** - Visual Debug features and usage
- **[Makerchip-public/docs/TLV_Macros_Guide.pdf](../Makerchip-public/docs/TLV_Macros_Guide.pdf)** - TLV macro library syntax and patterns

### Examples and Tutorials
- **[Makerchip-public/tutorial/tlv/](../Makerchip-public/tutorial/tlv/)** - Beginner-friendly tutorial examples
- **[makerchip_examples/](../makerchip_examples/)** - Extensive collection of real-world examples
- **[LF-Building-a-RISC-V-CPU-Core-Course/](../LF-Building-a-RISC-V-CPU-Core-Course/)** - Complete RISC-V CPU design course

### Advanced Examples
- **[warp-v/](../warp-v/)** - Configurable RISC-V CPU generator (production-quality example)
- **[warp-v_includes/](../warp-v_includes/)** - RISC-V ISA definitions and library patterns
- **[tlv_lib/](../tlv_lib/)** - General-purpose TL-Verilog component libraries
- **[tlv_flow_lib/](../tlv_flow_lib/)** - Transaction flow components and `$ANY` patterns

Note: For development, there may be a more recent working version of `Makerchip-public` in the workspace to reference instead.

## Working with the Makerchip VS Code Extension

### Typical Workflow

The Makerchip IDE is not just a development environment for humans. It is also accessible to you to code and debug. It provides access to SandPiper™, M5, and Verilator for compilation and simulation. It provides access to logs and waveform data for conventional debugging. Additionally, it's Visual Debug (VIZ) feature gives you the ability to create custom visualizations of machine state, which you can access as images as an alternative approach to text-based logging and debugging. [Coming soon: You can use the API to query specific signal values.]

Makerchip enables you to develop productively with the user. By presenting a design in this environment, the user can interact with code, waveforms, logic diagrams, and visualizations, all of which represent or can be annotated with simulation data. They can click on signals and other elements of the design in the various views (called panes) to highlight them across the views and correlate the various representations of the design and its simulation data. [Soon, you can highlight elements as well.]

Visual Debug is especially valuable in your collaboration with the user. You can convey your work visually and interactively by including `\viz_js` (VIZ) blocks within or alongside the TL-Verilog or Verilog code. It is much more natural for the user to understand your work visually than by reading static code and prose. A picture is worth a thousand words, and an animation is worth even more. Paired programming is much more productive with streamlined communication. The user continues to benefit from the visualizations in collaboration with their human peers and in sharing your open-source designs with others online.

Makerchip is also a teaching tool. When users request help with a digital logic concept or want to understand a feature of TL-Verilog or Makerchip, don't just describe it; demonstrate it in Makerchip. You can write code that implements a concept, write a testbench that drives meaningful stimulus, and show the user your design in action. You can code `\viz_js` blocks to represent your design to the user in the most natural way. And you can even play them back for the user to animate a concept or showcase your design. You can layout the Makerchip IDE to show the most relevant views. You can open tutorials, examples, and documents, available in the resources folder as well as third-party content found on-line, to include them right there in the IDE webview, accompanying the design.

#### Workflow pattern

1. Code TL-Verilog (or old-school Verilog, if specifically requested) with a testbench, VIZ, and assertions [integrated formal verification to come].
2. Compile code in the IDE (use `makerchip_compile` tool), awaiting logs and VCD simulation data.
3. Debug any errors and warnings (even non-fatal ones) indicated in the logs. Use simulation logs (if `$display` is used) and VCD simulation data (if not overwhelming). Interactively query Makerchip for simulation data and VIZ snapshots as needed to debug the issues.
4. Explain concepts and issues to the user using VIZ and by controlling the IDE layout, playback, etc.
5. Summarize your work. The user is likely not to read your prose explanations, so keep them to the point, favoring IDE visualizations to convey your points. Include a TL;DR summary.

#### Constraints

Makerchip is currently limited to compiling a single file. A single TL-Verilog file can include `\TLV` regions (where TL-Verilog constructs are enabled), within at most one Verilog module. These constraints imply that the testbench should be written in the same file using (System)Verilog (see the `Makerchip-public/tutorial/tlv/sv_tb_example.tlv` file), so the DUT module can use TL-Verilog. If the DUT does not need to be delivered as a self-contained module, you can, more simply, embed the testbench logic with the DUT logic in the same `top` module.

Makerchip is also currently limited to a single simulation. For early DUT-level development, this tends to work fine in practice and helps to keep things simple.

### IDE Plugin API Reference

Complete API documentation available at:
- `~/.vscode-makerchip/resources/Makerchip-public/docs/plugin_api/index.html` (local)
- [IdePlugin API Documentation](https://github.com/rweda/Makerchip-public/blob/main/docs/plugin_api/index.html) (online)

### IDE Layout Management

The IDE supports customizable pane layouts with splits and tabs. Layout management tools allow you to arrange panes programmatically.

**Pane Identification:**
- Panes are identified by **mnemonics** (unique identifiers like `"Diagram"`, `"Waveform"`, `"Log"`)
- Complex panes may include uniquifiers: `"Course Slides+Udemy"`, `"RISC-V Videos+Workshop"`
- The "+" character in mnemonics must be URL-encoded as "%2B" when used in URLs
- Use `makerchip_get_available_panes` tool to discover available panes and their mnemonics

**Pane Types:**
- **Editor Pane**: Not available in VS Code extension (VS Code provides its own editor)
- **(Other) Main Panes**: Always open (Log,Nav-TLV, Diagram, Waveform, VIZ)
- **Static Panes**: Defined in blade files, opened on demand

**Blade File Names**: Static pane blade files in `~/.vscode-makerchip/resources/Makerchip-public/pane-blade/` use **mnemonics as filenames** (with spaces and "+" characters). Examples:
- `Combo Tutorial.blade`
- `Course Slides+Udemy.blade`
- `RISC-V Videos+Workshop.blade`
- `Examples.blade`

These file names **exactly match** the mnemonics returned by `makerchip_get_available_panes` and used in `makerchip_set_layout_state`.

**Layout State Structure Examples:**

Tabbed view (single container):
```json
{
  "panes": ["Log", "Diagram", "Waveform"],
  "activePane": "Diagram"
}
```

Horizontal split (left/right):
```json
{
  "sides": {
    "left": { "panes": ["Log", "Nav-TLV"] },
    "right": { "panes": ["Diagram", "Waveform", "Viz"], "activePane": "Diagram" }
  }
}
```

Vertical split (top/bottom):
```json
{
  "sides": {
    "top": { "panes": ["Diagram"] },
    "bottom": { "panes": ["Waveform", "Log"] }
  }
}
```

### API Reference Documentation

**IDE Plugin API**: `~/.vscode-makerchip/resources/Makerchip-public/docs/plugin_api/index.html`
- Complete reference for all IDE methods available via `makerchip_ide_call` tool
- Includes IdePlugin class documentation with method signatures and descriptions

**VIZ API**: `~/.vscode-makerchip/resources/Makerchip-public/docs/viz_codo/index.html`
- SignalValue and SignalValueSet classes for accessing waveform data
- Used when writing custom visualization code in VIZ panes

### Best Practices for Assistance

1. **Prefer visualization**: When showing TL-Verilog examples, open them in Makerchip IDE rather than just displaying code
2. **Use correct syntax**: Follow TLX specification for TL-Verilog constructs
3. **Reference docs**: Point to specific PDF files and API documentation in this resources folder when explaining concepts
4. **Show progression**: For tutorials, build up complexity step-by-step
5. **Include VIZ**: When demonstrating circuits, include `\viz` annotations for better visualization

## Assisting with the Makerchip VS Code Extension

The user interacts with the Makerchip extension as follow and may need your guidance on how to use it effectively:

- **Keyboard Shortcut**: Press `Ctrl+Shift+Enter` to compile current file (in the "default" Makerchip webview, which opens if unavailable).
