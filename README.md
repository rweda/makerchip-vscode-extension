# Makerchip Extension

VS Code extension for Makerchip IDE integration, providing TL-Verilog development and compilation support with GitHub Copilot integration.

## Features

- **Compile/Simulate TL-Verilog**: Compile and visualize circuits directly in VS Code
- **Multiple Panels**: Work with different circuits simultaneously in named panels
- **GitHub Copilot Integration**: Language Model tools allow Copilot to launch Makerchip and demonstrate examples
- **Reference Data Management**: Automatic setup of documentation and examples
- **Keyboard Shortcut**: Press `Ctrl+Shift+Enter` to compile current file
- **Chat Participant**: Use `@makerchip` for direct interaction

## Usage

### Manual Usage

1. Open a `.tlv` file
2. Press `Ctrl+Shift+Enter` or run "Makerchip: Compile/Simulate" from the command palette
3. View compilation results, circuit diagrams, and waveforms in the webview panel

**Working with Multiple Panels:**
- Use "Makerchip: Compile/Simulate in Panel..." to select or create named panels
- Compare different designs side-by-side
- Quick panel selection from existing panels or create new ones

### With GitHub Copilot

Copilot can automatically:
- Compile and visualize TL-Verilog files directly in Makerchip
- Show examples directly in the Makerchip IDE (not just in chat)
- Switch between different IDE panes (Diagram, Waveform, Nav-TLV, etc.)
- Load code from files or URLs

Example prompts:
- "Show me a simple counter in Makerchip"
- "Open this in Makerchip and show the waveform"
- "Demonstrate a pipeline design in TL-Verilog"

## Copilot Enablement Architecture

This extension provides two Language Model tools that make Makerchip features accessible to Copilot:

### 1. `makerchip_compile` Tool

High-level tool for compiling/simulating files or code in Makerchip.

**Parameters:**
- `filePath` (optional): Path to a `.tlv` file to compile
- `code` (optional): TL-Verilog code to compile directly

**When invoked:**
1. Opens the specified file or creates a new document with the provided code
2. Launches the Makerchip IDE webview
3. Compiles the code and displays results

### 2. `makerchip_ide_call` Tool

Generic tool for calling any IDE method directly.

**Parameters:**
- `method` (required): IDE method name (e.g., `activatePane`, `setCode`, `getCode`)
- `args` (optional): Array of arguments to pass to the method

**Available Methods:**
- `compile(code)` - Compile TL-Verilog code
- `setCode(code, readOnly)` - Set editor code
- `getCode(lastChangeGeneration)` - Get current code
- `setCodeFromURL(url, readOnly)` - Load code from URL
- `activatePane(name)` - Switch to a specific pane ("Diagram", "Waveform", "Nav-TLV", etc.)
- `openStaticPane(name, background)` - Open a static pane

For complete IDE Plugin API documentation, see:
- Local: `~/.vscode-makerchip/resources/Makerchip-public/docs/plugin_api/index.html`
- Online: [IdePlugin API Documentation](https://github.com/rweda/Makerchip-public/blob/main/docs/plugin_api/index.html)

### Generic Message Protocol

All IDE interactions use a unified message format:

```typescript
// Extension → Webview
{
  type: 'ide',
  method: 'methodName',
  args: [...]
}

// Webview → Extension (results)
{
  type: 'ideResult',
  method: 'methodName',
  result: any
}

// Webview → Extension (errors)
{
  type: 'ideError',
  method: 'methodName',
  error: string
}
```

This generic approach means:
- **No code changes needed** to expose new IDE methods to Copilot
- **Future-proof**: New IDE features automatically become available
- **Consistent API**: Single mechanism for all IDE operations

### Helper Function

The extension exports `callIDE()` for convenient method invocation:

```typescript
import { callIDE } from './extension';

// Compile code
await callIDE('compile', code);

// Switch panes
await callIDE('activatePane', 'Waveform');

// Set code without compiling
await callIDE('setCode', code, false);
```

## Development

### Project Structure

```
src/
  extension.ts        - Main extension activation and commands
  makerchipTool.ts    - Language Model tool implementations
  makerchipParticipant.ts - Chat participant for @makerchip
  resourceManager.ts  - Manages documentation/example repositories
  webview.ts         - Client-side IDE integration (runs in webview)
  webview.html       - Webview HTML template
resources/           - Cloned TL-Verilog documentation and examples
```

### Building

```bash
npm install
npm run compile
```

### Key Design Decisions

1. **TypeScript throughout**: Both extension and webview code use TypeScript for consistency and type safety
2. **Separated webview**: HTML and TS are in separate files (not inline strings)
3. **Global context**: Extension context stored globally for cleaner API
4. **Flattened arguments**: `callIDE()` uses rest parameters for natural usage
5. **Generic protocol**: Single message type handles all IDE method calls

## Requirements

- VS Code 1.110.0 or higher
- GitHub Copilot (for AI features)

## Resources

The extension manages a directory `~/.vscode-makerchip/`, which it adds to your workspace. It contains:
- `reference/`: Quick access to reference data, especially for use by LLM agents (e.g., Copilot), including specifications, examples, the IDE API (exposed to this extension as `callIDE(...)`), etc.
- `compile-cache/`: A file cache of compilation results for debugging, analysis, and reloading without recompilation.
- `.vscode/skills/tlv-ecosystem.md`: A Copilot skill that references available reference resources and provides TL-Verilog ecosystem context.

## License

See LICENSE file.
