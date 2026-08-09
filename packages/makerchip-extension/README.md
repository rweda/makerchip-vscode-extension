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

The `./launch` script is the **single door for testing the extension**. Its one
argument selects **the sandhost you are developing against**--a deployed one
or a local `mono` via a cloudflared tunnel with its own VS Code workspace,
and VS Code profile:

```bash
# Deployed default server (beta.makerchip.com)
./launch

# Deployed server at an explicit URL (e.g. a versioned deploy)
./launch https://makerchip.com/v123

# A local mono clone (3 forms) (see resolution below)
./launch feature_x
./launch mono_feature_x
./launch ~/repos/mono_feature_x
```

A clone reference is resolved, in order, as: (1) a path to an existing clone
directory, (2) a directory `<name>` under `$MONO_REPO_PARENT_DIR` (default: the
parent of this extension repo, i.e. `~/repos`), or (3) the slug form `mono_<name>`
under that parent.

**The mono clone is the unit of coupling** —
`clone ↔ SandHost/port ↔ tunnel ↔ workspace ↔ VS Code profile` — so
`./launch <clone>` does everything needed to develop against it:

- starts the clone's SandHost (`bin/start`) if it isn't already running,
- ensures a Cloudflare tunnel to that SandHost's port,
- opens the clone's workspace (`.vscode-env/<clone>.code-workspace` inside the clone),
- in a VS Code profile (`--user-data-dir`) **dedicated to that clone**
  (`.vscode-env/profile` inside the clone), seeded with your normal settings.

Both the workspace and the profile are created and owned by the clone's own
`bin/vscode_setup` (via `install.sh`) (they live inside the clone under a
git-ignored `.vscode-env/` directory), which `./launch` delegates to — so `./launch`,
the clone's `bin/open_code` both open the **same** per-clone profile. Each
clone gets its own profile so each can run its own Extension Development Host
(EDH) (VS Code allows one EDH per `--user-data-dir`) with its own Copilot chats, while
sharing your settings/keybindings/snippets (symlinked, not copied). The deployed
modes (no clone) share one profile and open no workspace.

**Workflow for local development:**

1. **Launch against a clone** (from the extension repo):
   ```bash
   ./launch feature_x
   ```
   and stop it with `bin/stop`.

2. Make changes to mono → restart SandHost (`bin/start` in the clone) → run **Makerchip: Reload Panels** (or ask Copilot
   to reload panels) to reconnect open webviews to the fresh build (or just
   re-run `./launch <clone>`).

3. Make changes to the extension → reload the VS Code window (Developer: Reload
   Window). The EDH does not hot-reload; wait for `tsc` to finish first.

4. Re-running `./launch <clone>` reloads that clone's existing window — VS Code
   restarts the dev host to load the latest build (no duplicate) — and re-ensures
   the tunnel.

### Managing Tunnels

There's at most one tunnel per clone. The tunnel may remain up until you are finished with the `mono` repo.

**Start it.** If needed, `./launch <clone>` starts the tunnel (cloudflared, in its own
session via `setsid`) in the background; it keeps running until torn down. The tunnel is owned by the
clone: its URL is recorded in the clone's `sandhost/TUNNEL_INFO`, which the
extension re-reads (resolved from its workspace folder) whenever a panel is built
— so opening a new panel, reloading the window, or running **Makerchip: Reload
Panels** picks up the current tunnel.

**Stop it.** The tunnel is intentionally independent of the SandHost: `bin/stop` (and
`bin/start`'s restart) leave it running so an open window survives a SandHost
restart. Tear it down explicitly when you're done with the clone (e.g. before
trashing it):

```bash
bin/teardown_tunnel   # in the clone; stops cloudflared, clears sandhost/TUNNEL_INFO
```

**Restart it.** Though it may be kept open for the lifetime of the `mono` clone, if you do restart it, the Makerchip webviews simply need to be restarted.

Detached SandHosts and tunnels outlive a deleted/trashed clone. Find and clean
such strays with the clone's reaper (any clone's copy works — it scans the whole
machine):

```bash
bin/reap          # Report orphans, then prompt [y/N] to kill them.
                  # Or run with --report or --kill to avoid the prompt.
```

### Server Configuration

By default, the extension connects to `beta.makerchip.com`. You can override this:
- **Clone/tunnel mode**: (development only) `./launch <clone>` creates a tunnel to the clone's SandHost and records it in the clone's `sandhost/TUNNEL_INFO` (absent in production). The extension picks it up automatically. After restarting the tunnel or the SandHost server, run **Makerchip: Reload Panels** to reconnect already-open panels.
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
