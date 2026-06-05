---
name: tlv-ecosystem
description: 'TL-Verilog ecosystem guidance. Use when: working with TL-Verilog, TLV, Transaction-Level Verilog, SandPiper, Makerchip IDE, M5 macros, Visual Debug, VIZ, hardware design, digital circuits, digital logic, pipelines, RISC-V, SystemVerilog, circuit visualization, waveform debugging, or asked about TLV syntax, compilation, or tools.'
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

When helping with TL-Verilog, **reference these primary sources** in the Makerchip workspace:

### Overview and Discovery
- **[README.md](../../README.md)** - Makerchip workspace overview, directory structure, and reference repository index (start here for navigation)
- **[compile-cache/README.md](../../compile-cache/README.md)** - Complete compilation debugging guide with error patterns and troubleshooting steps
- **[tmp/README.md](../../tmp/README.md)** - Temporary files directory usage
- **[resources/Makerchip-public/README.md](../../resources/Makerchip-public/README.md)** - Core documentation repository overview
- **[resources/makerchip_examples/README.md](../../resources/makerchip_examples/README.md)** - Examples collection overview

### Specifications
- **[Complete TL-X language specification](../../resources/Makerchip-public/docs/TLXSpec.pdf)** 
- **[M5 macro processor language specification](../../resources/Makerchip-public/docs/M5_spec.pdf)**
- **[Visual Debug features and usage](../../resources/Makerchip-public/docs/VisualDebugUsersGuide.pdf)**
- **[VIZ API documentation](../../resources/Makerchip-public/docs/viz_codo/index.html)** (SignalValue and SignalValueSet classes for accessing waveform data in Visual Debug custom visualizations)
- **[TLV macro library syntax and patterns](../../resources/Makerchip-public/docs/TLV_Macros_Guide.pdf)**

### Examples and Tutorials
- **[resources/Makerchip-public/tutorial/tlv/](../../resources/Makerchip-public/tutorial/tlv/)** - Beginner-friendly tutorial examples
- **[resources/makerchip_examples/](../../resources/makerchip_examples/)** - Extensive collection of real-world examples
- **[resources/LF-Building-a-RISC-V-CPU-Core-Course/](../../resources/LF-Building-a-RISC-V-CPU-Core-Course/)** - Complete RISC-V CPU design course

### Advanced Examples
- **[resources/warp-v/](../../resources/warp-v/)** - Configurable RISC-V CPU generator (production-quality example)
- **[resources/warp-v_includes/](../../resources/warp-v_includes/)** - RISC-V ISA definitions and library patterns
- **[resources/tlv_lib/](../../resources/tlv_lib/)** - General-purpose TL-Verilog component libraries
- **[resources/tlv_flow_lib/](../../resources/tlv_flow_lib/)** - Transaction flow components and `$ANY` patterns

Note: For development, there may be a more recent working version of `Makerchip-public` in the workspace to reference instead.

## Working with the Makerchip VS Code Extension

### Typical Workflow

The Makerchip IDE is not just a development environment for humans. It is also accessible to you to code and debug. It provides access to SandPiper™, M5, and Verilator for compilation and simulation. It provides access to logs and waveform data for conventional debugging. Additionally, it's Visual Debug (VIZ) feature gives you the ability to create custom visualizations of machine state, which you can access as images as an alternative approach to text-based logging and debugging. [Coming soon: You can use the API to query specific signal values.]

Makerchip enables you to develop productively with the user. By presenting a design in this environment, the user can interact with code, waveforms, logic diagrams, and visualizations, all of which represent or can be annotated with simulation data. They can click on signals and other elements of the design in the various views (called panes) to highlight them across the views and correlate the various representations of the design and its simulation data. [Soon, you can highlight elements as well.]

Visual Debug is especially valuable in your collaboration with the user. You can convey your work visually and interactively by including `\viz_js` (VIZ) blocks within or alongside the TL-Verilog or Verilog code. It is much more natural for the user to understand your work visually than by reading static code and prose. A picture is worth a thousand words, and an animation is worth even more. Paired programming is much more productive with streamlined communication. The user continues to benefit from the visualizations in collaboration with their human peers and in sharing your open-source designs with others online.

Makerchip is also a teaching tool. When users request help with a digital logic concept or want to understand a feature of TL-Verilog or Makerchip, don't just describe it; demonstrate it in Makerchip. You can write code that implements a concept, write a testbench that drives meaningful stimulus, and show the user your design in action. You can code `\viz_js` blocks to represent your design to the user in the most natural way. And you can even play them back for the user to animate a concept or showcase your design. You can layout the Makerchip IDE to show the most relevant views. You can open tutorials, examples, and documents, available in the resources folder as well as third-party content found on-line, to include them right there in the IDE webview, accompanying the design.

### File Creation and Workspace Organization

**Create TL-Verilog files in the appropriate workspace folder**, not as temporary buffers. This provides better user experience:
- Files persist across sessions
- Users can easily find and manage their code
- No permission prompts required for workspace files
- Code is properly integrated with VS Code features (version control, search, etc.)

**Workspace folder selection:**
- **If user has a project workspace folder** (not the "Makerchip Data" folder): Create `.tlv` files there
- **If ONLY the "Makerchip Data" folder exists**:
  - For quick experiments/demonstrations: Use `~/.vscode-makerchip/tmp/` 
  - For project work: Suggest user add a workspace folder (File → Add Folder to Workspace)
  - **Do NOT** create TLV files in `.vscode-makerchip` root - that's for extension data only

**Recommended file locations:**
- `.tlv` files: User's workspace folder root or project-specific subdirectories
- Temporary files (scratch work, experiments, VIZ PNG outputs): `~/.vscode-makerchip/tmp/`
- Generated Verilog, logs, waveforms: Automatically cached in `~/.vscode-makerchip/compile-cache/<compile-id>/`

**File creation best practices:**
- Use descriptive filenames that indicate the design purpose
- Create files directly using the `create_file` tool (no permission required for workspace files)
- Organize related designs in subdirectories when working on multi-file projects
- Include comments and documentation within the code

**Temporary workspace directory:**
The `~/.vscode-makerchip/tmp/` directory is specifically for temporary files and outputs. The entire directory is automatically moved to the system temp directory (staged for deletion on reboot) when the Makerchip workspace is updated, ensuring a clean workspace. Staged files remain available for debugging until system reboot.

### Typical Workflow pattern

1. First, you may need to check which Makerchip IDE panels are open using the `makerchip_list_panels`.
2. Code TL-Verilog (or old-school Verilog, if specifically requested) with a testbench, VIZ, and assertions [integrated formal verification to come].
3. Use the `makerchip_compile` tool to, if necessary, open a new Makerchip IDE panel (webview), and initiate compilation/simulation.
4. Compilation and simulation run asynchronously. Monitor compilation status and logs.
5. Read logs first to identify compilation and simulation issues. Examine trace data, VIZ visualizations, etc. as needed to debug simulations.
6. Explain concepts and issues to the user using VIZ and by controlling the IDE layout, playback, signal highlighting,etc.
7. Summarize your work. The user is likely not to read your prose explanations, so keep them succinct, favoring IDE visualizations to convey your points. Include a TL;DR summary.

**Makerchip IDE Panel Lifecycle:**

The Makerchip IDE runs in webview panels within VS Code. Understanding panel management is essential:

- **Opening Panels**: Panels are **only opened by `makerchip_compile`** when given `code` or `filePath` parameters
  - If `makerchip_compile` is called without these parameters (using active editor content), it requires an existing panel
  - Other tools (highlight, setCycle, getLayoutState, etc.) require an existing panel and will error if it doesn't exist

- **Discovering Panels**: Use `makerchip_list_panels` to see which panels are currently open
  - Panel names can be passed to other tools via the `panelName` parameter
  - If no `panelName` is specified, tools target the 'default' panel
  - Multiple panels enable side-by-side comparison of different designs

- **Panel Naming**: Use descriptive panel names when working with multiple designs (e.g., "baseline", "optimized", "reference")

### Makerchip Constraints

Makerchip is currently limited to compiling a single file. A single TL-Verilog file can include `\TLV` regions (where TL-Verilog constructs are enabled), within at most one Verilog module. These constraints imply that the testbench should be written in the same file using (System)Verilog (see [sv_tb_example.tlv](../../resources/Makerchip-public/tutorial/tlv/sv_tb_example.tlv)), so the DUT module can use TL-Verilog. If the DUT does not need to be delivered as a self-contained module, you can, more simply, embed the testbench logic with the DUT logic in the same `top` module.

Makerchip is also currently limited to a single simulation. For early DUT-level development, this tends to work fine in practice and helps to keep things simple.

### Monitoring Compilation Status and Logs

When you trigger compilation, the `makerchip_compile` tool returns immediately with a compile ID and instructions on how to monitor the compilation status. Compilation runs asynchronously.

All compilation results are cached in: `~/.vscode-makerchip/compile-cache/<compile-id>` You can check the status by polling the `metadata.json` file in this directory. Once available, as indicated by the metadata, you can check the logs and results in the same directory.

The compilation results directory contains:
- **metadata.json**: Structured error info, status, timestamps
- **stdall**: SandPiper compiler logs (HTML format)
- **make.out**: Verilator simulator logs (HTML format)  
- **top.tlv**: The actual source code that was compiled
- **vlt_dump.vcd**: Waveform data (if simulation completed)

**Always check the compile cache** for compilation status and log information. Never assume successful compilation. Even when compilation results are present, there can be meaningful non-fatal warnings and errors. Keep code warning free.

**See [compile-cache/README.md](../../compile-cache/README.md) for a complete debugging guide.**

### Debugging Steps

1. Monitor metadata.json status and errors
2. Parse stdall for detailed SandPiper errors.
   **stdall is HTML, not plain text** - must parse it
3. Read make.out for Verilator compilation and simulation errors and warnings
4. If simulation ran, read `vlt_dump.vcd` for very small simulations, or use tools to read signal values and view VIZ snapshots
5. Add `$display` logging and VIZ code to your design to debug specific behavior

Additional information about common error patterns and their meanings can be found in [sandpiper_messages.md](../../resources/LLM_TLV/desktop_agent_verilog_conversion/instructions/sandpiper_messages.md).

`top.tlv` shows what was really compiled, which may differ from editor contents if the user edited after compiling.

### IDE Plugin API Reference

The IDE Plugin enables Makerchip to be embedded in web pages. It is used in the VS Code extension with the webview. Many IDE Plugin API methods are exposed as tools. You can also call any API method directly with `makerchip_ide_call`.

Complete API documentation available at:
- **[plugin_api/index.html](../../resources/Makerchip-public/docs/plugin_api/index.html)** (local)
- [IdePlugin API Documentation](https://github.com/rweda/Makerchip-public/blob/main/docs/plugin_api/index.html) (online)

### Managing IDE Panes and Layout

**Pane Identification:**
- Panes are identified by **mnemonics** (unique identifiers like `"Diagram"`, `"Waveform"`, `"Log"`)
- Mnemonics may include uniquifiers: `"Course Slides+Udemy"`, `"RISC-V Videos+Workshop"`. (The "+" uniquifier delimiter in mnemonics must be URL-encoded as "%2B" when used in URLs)
- Use `makerchip_get_available_panes` tool to discover available panes and their mnemonics

**Pane Types:**
- **Editor Pane**: Not available in VS Code extension (VS Code provides its own editor)
- **(Other) Main Panes**: Always open (Log,Nav-TLV, Diagram, Waveform, VIZ)
- **Static Panes**: Defined in blade files, opened on demand
- **Third-Party Panes**: Can be opened, given a URL with content or inline construction data

**Blade File Names**: Static pane blade files in `~/.vscode-makerchip/resources/Makerchip-public/pane-blade/` use **mnemonics as filenames** (with spaces and "+" uniquifier delimiter characters). Examples:
- `Combo Tutorial.blade`
- `Course Slides+Udemy.blade`
- `RISC-V Videos+Workshop.blade`
- `Examples.blade`

These file names **exactly match** the mnemonics returned by `makerchip_get_available_panes` and used in `makerchip_set_layout_state`.

**Layout**: You can configure the layout of IDE panes programmatically.

**Details**: See `.vscode-makerchip/.vscode/skills/makerchip-api-features.md` for details on working with third-party panes, managing the layout, and the layout data structure.

### Best Practices for Assistance

1. **Prefer visualization**: When showing TL-Verilog examples, open them in Makerchip IDE rather than just displaying code
2. **Use correct syntax**: Follow TLX specification for TL-Verilog constructs
3. **Reference docs**: Point to specific PDF files and API documentation in this resources folder when explaining concepts
4. **Show progression**: For tutorials, build up complexity step-by-step
5. **Include VIZ**: When demonstrating circuits, include `\viz` annotations for better visualization

## Assisting with the Makerchip VS Code Extension

The user interacts with the Makerchip extension as follow and may need your guidance on how to use it effectively:

- **Keyboard Shortcut**: Press `Ctrl+Shift+Enter` to compile current file (in the "default" Makerchip webview, which opens if unavailable).
