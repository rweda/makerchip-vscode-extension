# Makerchip Reference Data

This directory (`~/.vscode-makerchip/`) contains resources and cached data for the Makerchip VS Code extension.

**⚠️ Do not edit or create files here** - managed by the extension, changes will be overwritten on update.

## For Developers & Users

See **[.vscode/skills/tlv-ecosystem.md](.vscode/skills/tlv-ecosystem.md)** for comprehensive documentation on:
- TL-Verilog language, M5, Visual Debug, and Makerchip IDE
- Complete documentation references and examples
- Workflow patterns and best practices
- Compilation and debugging guidance

This skill file is the **primary source** of TL-Verilog knowledge for both Copilot and human developers.

## Directory Structure

```
~/.vscode-makerchip/
├── .copilot-instructions.md    # Workspace introduction for Copilot
├── .vscode/skills/
│   └── tlv-ecosystem.md        # Primary TL-Verilog documentation
├── resources/                   # Reference repositories (see below)
├── compile-cache/              # Compilation results (see subdirectory README)
├── tmp/                        # Temporary files (see subdirectory README)
└── README.md                   # This file
```

## Reference Repositories

The `resources/` directory contains cloned Git repositories:

- **Makerchip-public** - Core documentation, tutorials, API references
- **makerchip_examples** - Example circuits
- **LF-Building-a-RISC-V-CPU-Core-Course** - RISC-V CPU course
- **warp-v** - Advanced RISC-V CPU generator
- **warp-v_includes** - RISC-V ISA definitions
- **tlv_lib** - TL-Verilog component libraries
- **tlv_flow_lib** - Transaction flow components
- **Virtual-FPGA-Lab** - FPGA design in Makerchip
- **M5** - M5 macro processor source

See [.vscode/skills/tlv-ecosystem.md](.vscode/skills/tlv-ecosystem.md#documentation-references) for detailed documentation references.

## Usage

**Add to Workspace**: Command Palette → "Makerchip: Update Reference Data" or right-click `~/.vscode-makerchip/` → "Add Folder to Workspace"

Enables:
- Copilot context for TL-Verilog assistance
- Quick access to specs and examples
- Direct browsing of compilation cache
