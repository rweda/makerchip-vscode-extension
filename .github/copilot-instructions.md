# Makerchip VS Code Extension — Development Guide

See [`README.md`](../README.md) for repo structure, use models, coupling rationale, and
development workflow. Key constraints to preserve when making changes:

- **Preserve all three use models** (Desktop Makerchip, Web Makerchip, Editor-only TL-Verilog).
- **Keep `languageFeatures.ts` web-safe** — no `fs`, `path`, `axios`, or any Node-only API.
- **Do not fold language support into `makerchip-extension`** — the language layer must remain
  independently installable as `tl-verilog` so editor-only use is viable without Makerchip.
- **Grammar edits go in `tlv-grammar/` only** — `tlv-extension/syntaxes/tlverilog.tmLanguage` and
  `tlv-extension/language-configuration.json` are build artifacts copied by `scripts/copy-grammar.mjs`
  and are gitignored. Never edit them in `tlv-extension/`.
- **Co-dev setup:** `./launch` and "Run Extension" (F5) load both extensions from source via
  two `--extensionDevelopmentPath` args. The `watch: all` task builds both. Reload the
  Extension Development Host window after `tsc` finishes to pick up changes.
