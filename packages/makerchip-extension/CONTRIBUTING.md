# Contributing to the Makerchip extension

This package lives in the
[`makerchip-vscode-extension`](../../README.md) monorepo. Set up and build using
the monorepo guide — [CONTRIBUTING.md](../../CONTRIBUTING.md) — not by
installing in this directory.

Release process: [Releasing](../../README.md#releasing). Bump this manifest,
then push a `makerchip-vX.Y.Z` tag. Note that `makerchip` cannot be installed
from the Marketplace until `RedwoodEDA.tlverilog` is published, because of the
hard `extensionDependencies`.

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

Node.js 18+. This package lives in an npm workspaces monorepo — install and
build from the **repo root**, not from this directory:

```bash
npm install        # repo root
npm run compile    # repo root; builds all workspaces
```

`npm run package` (here) produces the .vsix.

### Notes for agents

- **`vsce package` needs `--no-dependencies`** (already in the `package`
  script). npm workspaces hoist dependencies to the repo root, so without the
  flag vsce walks `../` and fails with
  `invalid relative path: extension/../../package.json`.
- **This extension cannot be installed before `tlverilog` is published.**
  `extensionDependencies: ["RedwoodEDA.tlverilog"]` is a bare extension id
  with no version range, so VS Code installs whatever is latest and there is no
  way to require a minimum. Publish `tlverilog` first; nothing enforces it.
  For local development the `./launch` script loads both extensions from source,
  which satisfies the dependency without any Marketplace publish.
- **`resources/` ships inside the .vsix** and is populated into
  `~/.vscode-makerchip/` at runtime. `resources/tmp-README.md` is a template
  written into the user's temp directory — it is intentional, not leftover.
- **Releases are tag-driven**: bump this manifest, then push `makerchip-vX.Y.Z`.
  CI fails the job if the tag and manifest version disagree. See
  [Releasing](../../README.md#releasing).
- Still unpublished and pre-1.0 (`0.0.1`), with a stub `CHANGELOG.md`, no `icon`
  and no `license` field — see the pre-publish checklist in
  [PUBLISHING.md](../../PUBLISHING.md) before releasing.

### Running the extension

Launch an Extension Development Host with **F5 ("Run Extension")** for debugging
with breakpoints, or with the `./launch` script pointed at a deployed server:

```bash
./launch                             # Deployed default server
./launch https://makerchip.com/v123  # Deployed server at an explicit URL
```

Both load this extension and `tlverilog` from source. See the monorepo
[CONTRIBUTING.md](../../CONTRIBUTING.md#launching-the-extension-development-host)
for the full comparison.

By default the extension connects to `makerchip.com`; override the server with
the `makerchip.serverUrl` setting.

> **Redwood-internal:** developing against a local `mono` server clone
> (`./launch <clone>`, Cloudflare tunnels, per-clone VS Code profiles, F5
> discovery, `bin/reap`) is documented in
> [DEVELOPMENT-INTERNAL.md](../../DEVELOPMENT-INTERNAL.md). `mono` is a private
> Redwood repo.

### Key Design Decisions

1. **TypeScript throughout**: Both extension and webview code use TypeScript for consistency and type safety
2. **Separated webview**: HTML and TS are in separate files (not inline strings)
3. **Global context**: Extension context stored globally for cleaner API
4. **Generic dispatch**: One `{ type: 'ide', method, args }` message handles all IdePlugin calls (see [Dispatch transport](#dispatch-transport))

## AI Agent Enablement Architecture

This extension provides Language Model tools that make Makerchip features accessible to Copilot and other agents via the Microsoft harness. Tools are registered both declaratively (`package.json` contributions) and programmatically (tool class implementations).

**Tool specifications** (parameters, return values, detailed descriptions) are defined in `package.json` under `contributes.languageModelTools` — the single source of truth.

Two cross-cutting behaviors aren't obvious from any single tool's schema:

- **Only `makerchip_compile` can open new panels** (when `code` or `filePath` is provided); every other tool acts on already-open panels.
- **`makerchip_ide_call` is the generic escape hatch** to any IdePlugin API method, including ones not exposed as dedicated tools. For the full IdePlugin API, see:
  - Local: `~/.vscode-makerchip/resources/Makerchip-public/docs/plugin_api/index.html`
  - Online: [IdePlugin API Documentation](https://github.com/rweda/Makerchip-public/blob/main/docs/plugin_api/index.html)

### Dispatch transport

Every tool ultimately reaches the IDE through one message, sent by `callIDE()`
(exported from `extension.ts`):

```typescript
callIDE(method, args, panelName?, createIfNeeded?, requestId?, serverUrl?)
// posts to the webview: { type: 'ide', method, args, requestId? }
```

The webview invokes the named IdePlugin method and posts back either
`{ type: 'ideResult', method, result }` or `{ type: 'ideError', method, error }`,
correlated to the caller by `requestId`. `args` is an array; `panelName` selects the
target panel. This transport is why `makerchip_ide_call` can reach any IdePlugin
method (above) without new plumbing — only a *dedicated* tool needs its own
`package.json` entry and handler.
