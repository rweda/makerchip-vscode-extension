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

### Showing Examples and Visualizations

**IMPORTANT**: When the user asks to see, show, demonstrate, or visualize TL-Verilog code or examples:
- **Use the `makerchip_compile` tool** to open code in the Makerchip IDE
- **Do NOT just show code in the chat** - prefer opening it in the visual IDE
- The IDE provides circuit diagrams, waveforms, and Visual Debug output

**Use `makerchip_compile` tool when the user wants to:**
- See an example
- Visualize a circuit
- Run or compile TL-Verilog
- View waveforms or diagrams
- Test or demonstrate code

**Tool parameters:**
```json
{
  "code": "\\TLV_version 1d: tl-x.org\\n...",  // TL-Verilog code to show
  "filePath": "path/to/file.tlv"              // Or path to existing file
}
```

**Example workflow:**
1. User asks: "Show me a simple counter in TL-Verilog"
2. Generate the TL-Verilog code
3. **Use `makerchip_compile` tool** with the `code` parameter
4. The code opens in Makerchip IDE with visual output

### Advanced IDE Control

Use the `makerchip_ide_call` tool for advanced IDE operations:

**Switch to different panes:**
```json
{
  "method": "activatePane",
  "args": ["Waveform"]  // Options: "Diagram", "Waveform", "Nav-TLV", "Editor", "Log"
}
```

**Set code without compiling:**
```json
{
  "method": "setCode",
  "args": ["code here", false]  // second arg is readOnly flag
}
```

**Load code from URL:**
```json
{
  "method": "setCodeFromURL",
  "args": ["https://example.com/code.tlv", false]
}
```

**API Documentation:**
For complete IDE Plugin API reference, see:
- `~/.vscode-makerchip/resources/Makerchip-public/docs/plugin_api/index.html` (local)
- [IdePlugin API Documentation](https://github.com/rweda/Makerchip-public/blob/main/docs/plugin_api/index.html) (online)

### IDE Layout Management

**Layout State Tools** - Use these tools to customize the IDE pane arrangement:

- `makerchip_get_layout_state` - Get current layout configuration (splits, tabs, active panes)
- `makerchip_set_layout_state` - Apply a custom layout (arrange panes in splits/tabs)
- `makerchip_get_available_panes` - List all available panes with mnemonics and availability
- `makerchip_open_pane` - Open or activate a specific pane by mnemonic (supports both static and non-static panes)

**Pane Mnemonics:**
All panes are identified by mnemonics (unique identifiers). Use `makerchip_get_available_panes` to discover available panes. Mnemonics follow the pattern:
- Simple: `"Diagram"`, `"Waveform"`, `"Log"`
- With uniquifier: `"Course Slides+Udemy"`, `"RISC-V Videos+Workshop"`

**Important**: Mnemonics use the "+" character as a delimiter for uniquifiers. When passing mnemonics in URLs, encode "+" as "%2B".

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

**Layout State Structure:**
```json
// Single tabbed view
{
  "panes": ["Log", "Diagram", "Waveform"],
  "activePane": "Diagram"
}

// Horizontal split (left/right)
{
  "sides": {
    "left": { "panes": ["Log", "Nav-TLV"] },
    "right": { "panes": ["Diagram", "Waveform", "Viz"], "activePane": "Diagram" }
  }
}

// Vertical split (top/bottom)
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
- SignalValue and SignalValueSet classes for waveform data access
- Used for custom visualization code

### Best Practices for Assistance

1. **Prefer visualization**: When showing TL-Verilog examples, open them in Makerchip IDE rather than just displaying code
2. **Use correct syntax**: Follow TLX specification for TL-Verilog constructs
3. **Reference docs**: Point to specific PDF files and API documentation in this resources folder when explaining concepts
4. **Show progression**: For tutorials, build up complexity step-by-step
5. **Include VIZ**: When demonstrating circuits, include `\viz` annotations for better visualization

## Assisting with the Makerchip VS Code Extension

The user interacts with the Makerchip extension as follow and may need your guidance on how to use it effectively:

- **Keyboard Shortcut**: Press `Ctrl+Shift+Enter` to compile current file (in the "default" Makerchip webview, which opens if unavailable).
