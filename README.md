# Makerchip Extension

VS Code extension for Makerchip IDE integration, providing TL-Verilog development and compilation support with GitHub Copilot integration.

## Features

- **Compile/Simulate TL-Verilog**: Compile and visualize circuits directly in VS Code
- **Multiple Panes**: Work with different circuits simultaneously in named panes (views)
- **GitHub Copilot Integration**: Language Model tools allow Copilot to launch Makerchip and demonstrate examples
- **Reference Data Management**: Automatic setup of documentation and examples
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

## Development

### Quick Start with Launch Script

The `./launch` script provides a convenient way to test the extension:

```bash
# Launch extension connected to default server (beta.makerchip.com)
./launch

# Launch connected to a specific server URL
./launch https://makerchip.com

# Launch with local SandHost via cloudflared tunnel (auto-cleanup on close)
./launch :8800         # Tunnel to localhost:8800
./launch :             # Tunnel to localhost:8080 (default port)
```

**Workflow for local development:**

1. **Start local SandHost** (in mono repo):
   ```bash
   cd ../mono_vscode
   bin/start 8800
   ```

2. **Launch extension with tunnel** (in extension repo):
   ```bash
   cd ../makerchip-vscode-extension
   ./launch :8800
   ```

3. Make changes to mono → restart SandHost (step 1), no need to restart extension

4. Make changes to extension → close VS Code window and rerun `./launch :8800`

The tunnel is automatically created and torn down when VS Code closes. The server URL is passed via environment variable.

### Server Configuration

By default, the extension connects to `beta.makerchip.com`. You can override this:
- **Environment Variable**: `MAKERCHIP_SERVER_URL` (automatically set by `./launch` script)
- **VS Code Setting**: `makerchip.serverUrl` in your settings

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
- `openPane(name, background)` - Open and/or activate a pane
- `getCycle()` - Get the current waveform cycle/time step
- `setCycle(cycle)` - Set the current waveform cycle/time step
- `updatePlayState(isPlaying, cycleTimeout, startCyc, endCyc)` - Control waveform playback

For complete IDE Plugin API documentation, see:
- Local: `~/.vscode-makerchip/resources/Makerchip-public/docs/plugin_api/index.html`
- Online: [IdePlugin API Documentation](https://github.com/rweda/Makerchip-public/blob/main/docs/plugin_api/index.html)

### 3. IDE Layout Management Tools

Several tools enable programmatic control of IDE pane layouts:

**`makerchip_get_layout_state`** - Get current layout configuration
- Returns: Layout state object describing current split/tab arrangement

**`makerchip_set_layout_state`** - Apply custom layout configuration
- Parameters: `state` (layout state object with panes, splits, active pane)
- Use to arrange panes in custom configurations (horizontal/vertical splits, tabs)

**`makerchip_get_available_panes`** - List all available panes
- Returns: Array of pane objects with mnemonic, display name, description, and availability

**`makerchip_open_pane`** - Open or activate a specific pane by mnemonic

**`makerchip_update_play_state`** - Control waveform playback
- Parameters:
  - `isPlaying` (required): true to start, false to stop
  - `cycleTimeout` (optional): milliseconds between cycles
  - `startCyc` (optional): starting cycle
  - `endCyc` (optional): ending cycle (plays to waveform end if omitted)
- Use to start/stop Visual Debug playback with control over speed and cycle range

**Identifying Panes:**
All panes are identified by unique mnemonics used by layout tools and reported by `makerchip_get_available_panes`. Content for most panes can be found in `~/.vscode-makerchip/resources/Makerchip-public/pane-blade/` in files named <mnemonic>.blade. So, to display the content of `~/.vscode-makerchip/resources/Makerchip-public/pane-blade/Combo Tutorial.blade`, use the `makerchip_open_pane` tool with the name "Combo Tutorial" (the mnemonic returned by `makerchip_get_available_panes` for that pane).

**Main Panes:**
The following main panes are always open and available:
- "Editor"
- "Log"
- "Diagram"
- "Waveform"
- "Nav-TLV"
- "VIZ"


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
