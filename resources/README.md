# Makerchip Reference Data

This directory (`~/.vscode-makerchip/`) contains resources and cached data for the Makerchip VS Code extension.

**⚠️ Do not edit files in `.vscode-makerchip`** - changes will be overwritten on update.

## Directory Structure

```
~/.vscode-makerchip/
├── .vscode/
│   └── skills/
│       └── tlv-ecosystem.md   # GitHub Copilot skill
├── resources/              # Documentation, examples, and specifications
│   ├── Makerchip-public/  # Public documentation and tutorials
│   │   ├── docs/
│   │   │   ├── plugin_api/    # IDE Plugin API documentation
│   │   │   ├── viz_codo/      # VIZ API documentation
│   │   │   └── *.pdf          # Specifications (TLXSpec, etc.)
│   │   ├── tutorial/
│   │   └── ...
│   ├── warp-v/            # RISC-V CPU generator
│   ├── tlv_lib/           # TL-Verilog libraries
│   ├── makerchip_examples/
│   ├── LF-Building-a-RISC-V-CPU-Core-Course/
│   └── ...
├── compile-cache/         # Cached compilation results
│   └── {compileId}/
│       ├── metadata.json  # Compilation metadata
│       ├── compile.log    # Full compilation log
│       ├── results.vcd    # Waveform data
│       └── diagram.svg    # Circuit diagram
├── compile-history.json   # Index of recent compilations
└── README.md             # This file
```

## Contents

The `resources/` subdirectory contains 9 repositories with TL-Verilog documentation, specifications, examples, libraries, and courses:

- **Makerchip-public** - Core documentation and tutorial examples
- **makerchip_examples** - Wide range of example circuits  
- **LF-Building-a-RISC-V-CPU-Core-Course** - Complete RISC-V course
- **warp-v** - Advanced configurable RISC-V CPU generator
- **warp-v_includes** - RISC-V library definitions
- **tlv_lib** - General-purpose TL-Verilog libraries
- **tlv_flow_lib** - Transaction flow component library
- **M5** - M5 macro processor source code

### GitHub Copilot Skill

The `.vscode/skills/tlv-ecosystem.md` file at the top level provides Copilot with comprehensive TL-Verilog context.

## GitHub Copilot Integration

**For complete information about TL-Verilog, Makerchip, M5, and Visual Debug**, see:

📘 **[.vscode/skills/tlv-ecosystem.md](../.vscode/skills/tlv-ecosystem.md)**

This skill provides Copilot with:
- Technology overviews and how they relate
- References to all specifications and documentation  
- Pointers to examples and tutorials
- Best practices for working with the Makerchip VS Code extension
- Best practices for collaborating with extension users

When this directory is added to your VS Code workspace, Copilot automatically uses this skill to provide context-aware help for TL-Verilog development.

## Key Documentation Files

- `resources/Makerchip-public/docs/TL-X Spec.pdf` - TL-X language specification  
- `resources/Makerchip-public/docs/M5 Spec.pdf` - M5 macro processor spec
- `resources/Makerchip-public/docs/VIZ Guide.pdf` - Visual Debug guide
- `resources/Makerchip-public/docs/Macros Guide.pdf` - TLV macros reference
- `resources/Makerchip-public/docs/plugin_api/index.html` - IDE Plugin API
- `resources/Makerchip-public/docs/viz_codo/index.html` - VIZ API

## IDE Pane Blade Files

Static pane content is defined in blade template files, available in `resources/Makerchip-public/pane-blade/`. These files use **mnemonics as filenames**, matching the identifiers used in IDE layout management:

**File Naming Convention:**
- File names use the exact pane mnemonic with `.blade` extension
- A suffix beginning with a "+" character is a uniquifier
- The mnemonic without the uniquifier provides the Makerchip tab text for the pane

**Examples:**
- `Combo Tutorial.blade` - Combinational logic tutorial
- `Course Slides+Udemy.blade` - Udemy course slides
- `RISC-V Videos+Workshop.blade` - RISC-V workshop videos
- `Examples.blade` - Code examples pane
- `VIZ Guide.pdf` - Corresponding documentation

**Consistency with IDE:**
These mnemonic-based file names are consistent with:
- `makerchip_get_available_panes` tool output (returns mnemonics)
- `makerchip_set_layout_state` tool input (uses mnemonics for pane references)
- `makerchip_get_layout_state` tool output (pane arrays use mnemonics)

When working with IDE layouts programmatically, use the mnemonics returned by `makerchip_get_available_panes` or found in `resources/Makerchip-public/pane-blade/` file names to ensure correct pane references.

## Compilation Cache

The `compile-cache/` directory stores results from Makerchip compilations for quick access:

- **Fast retrieval**: Re-access compilation results without recompiling
- **Analysis**: GitHub Copilot can analyze logs and waveforms
- **History**: `compile-history.json` provides searchable index
- **Age-based pruning**: Results pruned based on age and pass/fail status (see cache policy in source)

## Usage

**Add to Workspace**: Run the command "Makerchip: Update Resources" or right-click `~/.vscode-makerchip/` in VS Code and select "Add Folder to Workspace"

This enables:
- Quick access to specifications and examples
- GitHub Copilot context from the skill file
- Direct file browsing of compilation cache
