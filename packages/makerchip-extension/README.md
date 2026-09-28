# Makerchip Extension

VS Code extension for Makerchip IDE integration and AI-collaborative Verilog/TL-Verilog development, debug, and visualization.

## Features

- **Compile/Simulate Verilog, TL-Verilog, and Other HDLs**: Compile and visualize circuit simulations directly in VS Code
- **AI Agent Integration**: Language Model tools enable AI agents to work interactively in Makerchip with designers and learners
- **AI RAG Knowledge Base**: AI Agents are upskilled for TL-Verilog and Makerchip development

## Requirements

- VS Code 1.110.0 or higher
- GitHub Copilot or Microsoft's Claude/Codex harness (for AI features)

## Usage

### Manual Usage

1. Open a `.tlv` file
2. Press `Ctrl+Shift+Enter` or run "Makerchip: Compile/Simulate" from the command palette
3. View compilation results, circuit diagrams, and waveforms in the webview panel

**Working with Multiple Panels:**
- Use "Makerchip: Compile/Simulate in Panel..." to select or create named panels
- Compare different designs side-by-side
- Quick panel selection from existing panels or create new ones

**Highlighting Signals and Entities:**
- Use "Makerchip: Highlight Entity" to highlight signals, scopes, or pipeline stages across all views
- Use "Makerchip: Clear All Highlights" to remove all highlights
- Enter TL-Verilog paths like `/cpu|decode$valid`, `|fetch@1`, or `/cpu`

### With GitHub Copilot

Copilot can:
- Compile and visualize TL-Verilog files directly in Makerchip
- Show examples directly in the Makerchip IDE (not just in chat)
- Layout the IDE panes.
- Switch between different IDE panes (Diagram, Waveform, Nav-TLV, etc.)
- Load third-party content like HTML, PDF, etc. into panes
- Highlight signals, scopes, and pipeline stages to guide exploration

Example prompts:
- "Show me a simple counter in Makerchip"
- "Open this CPU in Makerchip and show the waveform and live logic diagram at cycle 20, highlighting signals related to the bypass logic."
- "Demonstrate a pipeline design in TL-Verilog"
- "Create a tic-tac-toe game in TL-Verilog with VIZ and show it in Makerchip"
- "Which signal are you talking about?"
- "I'm having trouble understanding 'when' conditions. Create a simple course with exercises to step me through it and open it in Makerchip."

## Contributing

Development setup, the `./launch` sandhost workflow, the Copilot tool
architecture and the release process are in [CONTRIBUTING.md](CONTRIBUTING.md).

## RAG Data

The extension manages `~/.vscode-makerchip/` containing reference data for AI assistants:
- **resources/**: Documentation, examples, and specifications
- **compile-cache/**: Compilation results for debugging - see [compile-cache/README.md](resources/compile-cache-README.md)
- **skills/**: Copilot skills including [tlv-ecosystem.md](resources/skills/tlv-ecosystem.md)

## License

[MIT](LICENSE) © Redwood EDA, LLC
