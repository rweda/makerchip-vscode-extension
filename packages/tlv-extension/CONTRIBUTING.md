# Contributing to the TL-Verilog extension

This package lives in the
[`makerchip-vscode-extension`](../../README.md) monorepo. Set up, build and run
it using the monorepo guide — [CONTRIBUTING.md](../../CONTRIBUTING.md) — not by
installing in this directory.

```bash
npm install        # repo root
npm run compile    # repo root; builds all workspaces
npm run package    # here; produces the .vsix
```

Release process: [Releasing](../../README.md#releasing). Bump this manifest,
then push a `tlv-vX.Y.Z` tag.

## Where the language features live

| File | Role |
|------|------|
| `src/extension.ts` | Desktop entry point (`main`) |
| `src/browser.ts` | Web entry point (`browser`), bundled by `esbuild.mjs` |
| `src/languageFeatures.ts` | Hover provider + semantic tokens registration; the web-safe core |
| `src/semanticTokenProvider.ts` | TL-Verilog token classification |
| `src/moduleInstantiation.ts` | `extension.tlverilog.instantiateModule` |
| `src/experimental/` | Node-only extras, gated by `tlverilog.experimentalFeatures` |

The color scheme is **not** a theme. It comes from
`contributes.semanticTokenTypes` plus `contributes.configurationDefaults`
(`editor.semanticTokenColorCustomizations`, with a `[*Dark*]` override), so it
layers over whatever theme the user has. Colors are edited in `package.json`.

## Notes for agents

- **`syntaxes/` and `language-configuration.json` here are generated and
  gitignored.** `scripts/copy-grammar.mjs` overwrites them from
  `packages/tlv-grammar/` on every build. Edits made here are silently lost —
  edit the grammar package instead.
- **The `@rweda/tlv-grammar` devDependency resolves nothing.** The copy script
  reads `../tlv-grammar` by relative path, not from `node_modules`, which is why
  this builds against a grammar that has never been published to npm.
- **`vsce package` needs `--no-dependencies`** (already in the `package`
  script). Without it, workspace hoisting makes vsce walk `../` and fail with
  `invalid relative path: extension/../../package.json`.
- **axios is declared but not shipped.** Its only importers,
  `src/experimental/sandpiperClient.ts` and `src/experimental/sandpiperCompile.ts`,
  are commented out of the import graph in `src/experimental/index.ts`, and
  `--no-dependencies` keeps axios out of the .vsix. Re-enabling the SandPiper
  compile button without bundling axios ships an extension that fails to load.
- **There is no contributed color theme, by design.** The TL-Verilog color
  scheme comes from `contributes.semanticTokenTypes` plus
  `contributes.configurationDefaults`
  (`editor.semanticTokenColorCustomizations`, with a `[*Dark*]` override). Two
  orphaned theme files under `themes/` were removed — they were registered
  nowhere and referenced by nothing. Colors are edited in `package.json`, not in
  a theme file.
- **`vscode:prepublish` runs `npm run clean` first, on purpose.** `tsc` never
  removes output for deleted sources, so `out/` accumulates compiled JS for
  files that no longer exist — this extension was shipping `diagram.js` and
  `navTlv.js` from the removed Nav-TLV and Diagram features until the clean step
  was added. Don't drop it.
- **Releases are tag-driven**: bump this manifest, then push `tlv-vX.Y.Z`. CI
  fails the job if the tag and the manifest version disagree. A user-visible
  grammar change also needs a grammar release first — see
  [Releasing](../../README.md#releasing).
