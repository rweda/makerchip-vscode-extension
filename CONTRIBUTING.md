# Contributing

Development guide for the `makerchip-vscode-extension` monorepo. For what the
three packages are and how they relate, see [README.md](README.md). For how
releases work, see [Releasing](README.md#releasing).

> **Redwood developers:** co-developing the extension against a local `mono`
> server clone (tunnels, per-clone VS Code profiles, `./launch <clone>`) is a
> Redwood-internal workflow documented in
> [DEVELOPMENT-INTERNAL.md](DEVELOPMENT-INTERNAL.md). `mono` is a private
> Redwood repo, so that flow is not part of this public guide.

## Development

### Prerequisites

- **Linux or macOS** (on Windows, use WSL). Native Windows is not supported; one known
  reason is under [Notes for agents](#notes-for-agents-working-in-this-repo).
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

Two ways in, and they are not interchangeable:

- **F5 ("Run Extension")** launches the EDH as a debug session of the current
  window, so **breakpoints bind**. Use this whenever you need the debugger.
- **`./launch`** opens an EDH pointed at a server, but shells out to `code` with
  no debugger attached — breakpoints will not bind. Prefer it for quick manual
  testing; reach for F5 when you need breakpoints.

Both load **both** `makerchip-extension` and `tlv-extension` from source (two
`--extensionDevelopmentPath` args), which satisfies the hard
`extensionDependencies` without a Marketplace publish.

`./launch`'s single argument selects the server you develop against:

```bash
./launch                             # Deployed default server
./launch https://makerchip.com/v123  # Deployed server at an explicit URL
```

`./launch <clone>` instead targets a local `mono` server clone — a
Redwood-internal flow; see
[DEVELOPMENT-INTERNAL.md](DEVELOPMENT-INTERNAL.md). You can also point any EDH at
a specific server with the `makerchip.serverUrl` setting.

### Co-developing both extensions

The "Run Extension" launch config (F5) and the `./launch` script both pass two
`--extensionDevelopmentPath` args so edits to either extension are picked up together.
The default build task (`watch: all`) runs `tsc -watch` for both in parallel.

**Important:** the Extension Development Host does **not** hot-reload. After `tsc` finishes
recompiling (watch terminal shows "Found 0 errors. Watching…"), reload the dev-host window
to activate the new code.

## Notes for agents working in this repo

Things that are easy to get wrong here and cost a debugging session:

- **`vsce package` must pass `--no-dependencies`.** npm workspaces hoist dependencies to
  the repo root, so plain `vsce package` walks `../` and dies with
  `invalid relative path: extension/../../package.json`. Both `package` scripts already
  pass the flag — don't "clean it up".
- **The `package` scripts need a POSIX shell**, one reason native Windows is unsupported
  (see Prerequisites). They expand `${GITHUB_REF_NAME:-main}` to pin each README's
  Marketplace links to the release tag (see [README.md](README.md#releasing)). On Windows,
  npm runs scripts in `cmd` by default, which leaves that text unexpanded and packages a
  listing with broken links.
- **`packages/tlv-extension/syntaxes/` and
  `packages/tlv-extension/language-configuration.json` are generated and gitignored.**
  `copy-grammar.mjs` overwrites them from `packages/tlv-grammar/` on every build. Edits
  there are silently lost; edit the grammar package.
- **`vscode:prepublish` runs `npm run clean` first, on purpose.** `tsc` never removes
  output for deleted sources, so without it a locally built .vsix ships dead code from
  files that no longer exist. Don't drop the clean step.
- **axios is a declared dependency of `tl-verilog` that is not shipped.** Its only
  importers are commented out of the graph in `src/experimental/index.ts`, and
  `--no-dependencies` leaves it out of the .vsix. Re-enabling the SandPiper compile button
  without bundling axios ships an extension that fails to load.
- **Each package's `LICENSE` is a real copy of the repo `LICENSE`, not a
  symlink.** `npm pack` silently omits a symlinked LICENSE — the tarball ships
  with no license at all — and a Windows checkout without symlink support turns
  the link into a text file containing the target path. `ci.yml` diffs the
  copies against the repo LICENSE on every push, so keep them byte-identical.

## Per-package contributor docs

- [`packages/tlv-extension/CONTRIBUTING.md`](packages/tlv-extension/CONTRIBUTING.md)
- [`packages/makerchip-extension/CONTRIBUTING.md`](packages/makerchip-extension/CONTRIBUTING.md)
- The grammar package has no build step; see
  [`packages/tlv-grammar/README.md`](packages/tlv-grammar/README.md).

## Pull requests

- Branch off `main`; CI runs build, lint and a LICENSE-consistency check on
  every push and PR.
- Keep each package's `CHANGELOG.md` current — releases are cut from tags and
  the changelog is what users see on the Marketplace.
- Don't bump versions in a feature PR. Version bumps belong to the release
  step; see [Releasing](README.md#releasing).
