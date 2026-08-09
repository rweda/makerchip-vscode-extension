# Makerchip VS Code Extension — Monorepo

This is an **npm workspaces monorepo** containing three published/publishable packages:

| Package | npm / VS Code id | Purpose |
|---------|-----------------|---------|
| `packages/tlv-grammar` | `@rweda/tlv-grammar` | TL-Verilog TextMate grammar and language configuration. Framework-neutral — reused by VS Code, Monaco, Shiki, and GitHub Linguist. No runtime code. |
| `packages/tlv-extension` | `redwood-eda.tl-verilog` | **TL-Verilog language extension**: `.tlv`/`.TLV` registration, grammar, snippets, semantic tokens, hovers, and (desktop-only) module instantiation. Grammar files are **copied from `tlv-grammar` at build time** — edit only in `tlv-grammar/`. |
| `packages/makerchip-extension` | `redwood-eda.makerchip` | **Makerchip IDE integration**: server-connected webview (compile/simulate, diagram, waveform, Nav-TLV, VIZ), GitHub Copilot LM tools, `@makerchip` chat participant, local compile cache. |

## Supported use models

Three use models drive architectural decisions:

1. **Desktop Makerchip** — full IDE + Copilot + local compile cache + local tools (webview,
   module instantiation, experimental SandPiper SaaS / Verilator / GTKWave buttons).
2. **Web Makerchip** (vscode.dev / github.dev) — server-hosted IDE + web-safe language
   features; no local FS or tool spawning.
3. **Editor-only TL-Verilog** — highlighting, semantic tokens, snippets, and hovers with
   no Makerchip server or network, fully offline, both hosts. Served by the standalone
   `tl-verilog` extension. The grammar is also consumed outside VS Code entirely (GitHub
   Linguist, Shiki, Monaco).

## Package coupling

`makerchip` declares a hard `extensionDependencies` on `redwood-eda.tl-verilog`. VS Code
auto-installs `tl-verilog` alongside Makerchip and won't activate Makerchip without it.
`makerchip` contributes no language definition or grammar itself — it only references the
`tlverilog` language id in `when` clauses.

The language layer is kept as a separate, independently installable extension so that
editor-only TL-Verilog (use model 3) remains viable without pulling in the Makerchip IDE.

## Development

### Prerequisites

- Node.js ≥ 18, npm (workspaces used for shared deps)
- Install all dependencies: `npm install` from the repo root

### Building

```bash
# One-shot build of all packages
npm run compile

# Watch mode for all packages (started automatically on folder open in VS Code)
# Both makerchip-extension and tlv-extension rebuild on save.
# See .vscode/tasks.json
```

### Launching the Extension Development Host

**Always** launch the VS Code Extension Development Host via the `./launch` script. A convenience symlink at the repo root (`./launch`) forwards to the real script
in [`packages/makerchip-extension`](packages/makerchip-extension/README.md#quick-start-with-launch-script).
Its single argument selects **the sandhost you develop against** — a deployed
URL or a local `mono` clone:

```bash
./launch                             # Deployed default server (beta.makerchip.com)
./launch https://makerchip.com/v123  # Deployed server at an explicit URL
./launch example_videos              # A local mono clone (mono_example_videos)
```

For a clone it wires up everything (SandHost, Cloudflare tunnel, dedicated
workspace, dedicated VS Code profile) and loads **both** `makerchip-extension`
and `tlv-extension` from source, satisfying the hard `extensionDependencies`
without a Marketplace publish. Clone resolution, tunnel ownership/teardown, the
`bin/reap` reaper, and the full per-clone workflow are documented in the
[package README](packages/makerchip-extension/README.md#quick-start-with-launch-script).

### Co-developing both extensions

The "Run Extension" launch config (F5) (default deployed sandhost only) and the `./launch` script both pass two
`--extensionDevelopmentPath` args so edits to either extension are picked up together.
The default build task (`watch: all`) runs `tsc -watch` for both in parallel.

**Important:** the Extension Development Host does **not** hot-reload. After `tsc` finishes
recompiling (watch terminal shows "Found 0 errors. Watching…"), reload the dev-host window
to activate the new code.
