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

## Development

### Quick Start with Launch Script

The `./launch` script provides a convenient way to test the extension:

```bash
# Launch extension connected to default server (beta.makerchip.com)
./launch

# Launch connected to a specific server URL
./launch https://makerchip.com

# Launch with local SandHost via cloudflared tunnel
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

3. Make changes to mono → restart SandHost (step 1) on same port, no need to restart extension

4. Make changes to extension → reload VS Code window (Developer: Reload Window)

5. When done, stop the tunnel with its teardown script (see below).

`./launch :port` starts the tunnel (cloudflared, under `nohup`) in the background
and **exits immediately**, returning your shell; the tunnel keeps running until
you tear it down. Each tunnel's URL is stored in a per-port file
`ACTIVE_TUNNELS/<port>` and reused across window reloads. Multiple tunnels
(different ports) can run at once; each launched window is bound to its own
tunnel via the `MAKERCHIP_TUNNEL_URL` environment variable that `./launch`
passes to `code`.

Every tunnel gets a teardown script at `ACTIVE_TUNNELS/stop_<port>.sh`. The
convenient way to run it is `./stop <port>` (a proxy for that script); it stops
the tunnel and removes all of its state (or just `kill <pid>`):

```bash
./stop 8800
```

### Server Configuration

By default, the extension connects to `beta.makerchip.com`. You can override this:
- **Tunnel mode**: (development only) `./launch :port` creates a tunnel, records it under `ACTIVE_TUNNELS/<port>`, and binds the window to it via `MAKERCHIP_TUNNEL_URL` (neither exists in production). When exactly one tunnel is active, the extension also picks it up automatically from `ACTIVE_TUNNELS/`.
- **VS Code Setting**: `makerchip.serverUrl` in your settings

## Copilot Enablement Architecture

This extension provides Language Model tools that make Makerchip features accessible to Copilot. Tools are registered both declaratively (`package.json` contributions) and programmatically (tool class implementations).

**Tool specifications** (parameters, return values, detailed descriptions) are defined in `package.json` under `contributes.languageModelTools`. See that file for complete API documentation.

### Available Tools

**General:**
- `makerchip_compile` - High-level tool for compiling/simulating files or code. **Only this tool can open new panels** (when `code` or `filePath` is provided).
- `makerchip_ide_call` - Generic tool for calling any IDE Plugin API method directly. Many of these methods are explicitly exposed as tools. For full IDE Plugin details, see:
  - Local: `~/.vscode-makerchip/resources/Makerchip-public/docs/plugin_api/index.html`
  - Online: [IdePlugin API Documentation](https://github.com/rweda/Makerchip-public/blob/main/docs/plugin_api/index.html)
- `makerchip_list_panels` - List all currently open Makerchip panels. This can be good to call before starting work.

**Layout Management:**
- `makerchip_get_layout_state` - Get current IDE pane layout configuration
- `makerchip_set_layout_state` - Apply custom layout (splits, tabs, active pane)
- `makerchip_get_available_panes` - List all available panes with metadata
- `makerchip_open_pane` - Open/activate a specific pane by mnemonic
- `makerchip_open_third_party_pane` - Load third-party content (HTML/PDF) into panes

**View Interaction:**
- `makerchip_get_cycle` - Get active cycle/time step
- `makerchip_set_cycle` - Jump to a specific cycle
- `makerchip_update_play_state` - Control waveform playback (play/pause/speed)
- `makerchip_get_viz_image` - Capture VIZ visualization as image
- `makerchip_highlight` - Highlight signals/scopes/stages across all views
- `makerchip_clear_highlights` - Clear all highlights

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

Using NPM 18+:

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

## RAG Data

The extension manages `~/.vscode-makerchip/` containing reference data for AI assistants:
- **resources/**: Documentation, examples, and specifications
- **compile-cache/**: Compilation results for debugging - see [compile-cache/README.md](resources/compile-cache-README.md)
- **skills/**: Copilot skills including [tlv-ecosystem.md](resources/skills/tlv-ecosystem.md)

## License

See LICENSE file.
