# Makerchip Extension

VS Code extension for Makerchip IDE integration and AI-collaborative Verilog/TL-Verilog development, debug, and visualization.

![Makerchip](./images/screenshot.png)

## Features

- **Compile/Simulate Verilog, TL-Verilog, and Other HDLs**: Compile and visualize circuit simulations directly in VS Code
- **AI Agent Integration**: Language Model tools enable AI agents to work interactively in Makerchip with designers and learners
- **AI RAG Knowledge Base**: AI Agents are upskilled for TL-Verilog and Makerchip development

## Before You Begin

> This extension is early, experimental software, provided **as is**, without warranty of any kind. Features, tools and settings may change or disappear without notice. Expect rough edges, and please [report them](https://github.com/rweda/makerchip-vscode-extension/issues) or submit pull requests.
>
> **Makerchip is built for open-source development only.** Your code is compiled on Makerchip servers and communication is insecure. **Do not share proprietary code or sensitive information.** Various features including third-party plugins may exchange data with third-party servers. **Develop with trusted code only.**
>
> **Terms.** Your use of the Makerchip service is governed by the Makerchip [Terms of Service](https://makerchip.com/terms/) and [Privacy Policy](https://makerchip.com/privacy/). The extension itself is MIT-licensed and provided as is (see [License](#license)). To the fullest extent permitted by law, Redwood EDA, LLC accepts no liability for any loss or damage arising from its use.

## Requirements

- Desktop VS Code 1.110.0 or higher (not vscode.dev or github.dev)
- An internet connection to Makerchip (and GitHub, for agent reference data)
- `git`, to download agent reference data
- GitHub Copilot or Microsoft's Claude/Codex harness (for AI features)

VS Code also installs the companion [TL-Verilog](https://marketplace.visualstudio.com/items?itemName=RedwoodEDA.tlverilog) language extension, for syntax highlighting of `.tlv` files.

## Usage

### Manual Usage

**Compiling, Simulating, and Debugging:**
1. Open a `.tlv` file
2. Press `Ctrl+Shift+Enter`, click the Makerchip icon, or run "Makerchip: Compile/Simulate" from the command palette. (Use "Makerchip: Compile/Simulate in Panel..." to select or create named panels.)
3. Explore the results in the Makerchip panel's views: Log, Diagram (a live logic diagram), Waveform, Nav-TLV (navigable, expanded source), and VIZ (custom visualizations)

### With AI Agents

AI Agents can:
- Author and compile TL-Verilog files directly in Makerchip, within VS Code
- Create and debug custom visualizations (Visual Debug) that explain their work
- Layout and activate IDE views
- Author and load third-party content into Makerchip views that interacts with the IDE
- Highlight relevant signals, scopes, and pipeline stages
- Capture images and videos (GIF, MP4, WebM, APNG) of simulation visualizations, with camera pan and zoom
- Compile C, C++, or assembly through Compiler Explorer and run it on a configurable [WARP-V](https://warp-v.org) RISC-V CPU
- Build Live Docs: extract a figure from a PDF, such as a slide or a textbook diagram, and animate it with simulation values (asking first about your rights to the document)

Example prompts:
- "Show me how a UART controller works."
- "Open my CPU in Makerchip and show the waveform and live logic diagram at the time of the first memory write, highlighting the write data signal."
- "Demonstrate a pipeline design in TL-Verilog"
- "Create a tic-tac-toe game in TL-Verilog with VIZ and show it in Makerchip"
- "I'm having trouble understanding 'when' conditions. Create a simple course with exercises to step me through it interactively in Makerchip."

## Agent Resources

The extension manages `~/.vscode-makerchip/` containing reference data for AI assistants:
- **resources/**: Documentation, examples, and specifications
- **skills/**: AI agent skills including [tlv-ecosystem.md](resources/skills/tlv-ecosystem.md)
- **compile-cache/**: Compilation results for debugging - see [compile-cache/README.md](resources/compile-cache-README.md)

If Claude Code is installed, the extension also writes a Makerchip skill to `~/.claude/skills/makerchip/`, so that Claude learns the rules for Makerchip tools before its first call. It is removed when the extension is uninstalled.

## Contributing

Development setup, the `./launch` workflow, the Copilot tool architecture and the release process are in [CONTRIBUTING.md](CONTRIBUTING.md).

Contribute content to the Makerchip community, such as Plugin Views and TL-Verilog models by submitting pull requests to [this repository](https://github.com/stevehoover/makerchip-community-contributions).

## License

[MIT](LICENSE) © Redwood EDA, LLC
