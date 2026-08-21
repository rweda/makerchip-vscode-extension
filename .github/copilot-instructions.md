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
- **`./launch` is clone-centric:** `./launch <mono-clone>` is the single door — it starts the
  clone's SandHost if down, ensures a Cloudflare tunnel, and opens the clone's workspace in a
  per-clone VS Code profile (`--user-data-dir`). `./launch <url>` / bare `./launch` target a
  deployed server. The clone is the unit of coupling
  (clone ↔ port ↔ tunnel ↔ workspace ↔ profile). See [`README.md`](../README.md).
- **Co-dev setup:** `./launch` and "Run Extension" (F5) load both extensions from source via
  two `--extensionDevelopmentPath` args. The `watch: all` task builds both. Reload the
  Extension Development Host window after `tsc` finishes to pick up changes.
- **Issues are a live backlog, not a changelog** — `issues/NNN-slug.md` files track *current status
  and remaining work only*. As work completes, remove it from the issue and fold durable outcomes
  into code/docs/READMEs; rely on Git history for how things evolved (no dated "vN/shipped/verified"
  narration). See [`issues/README.md`](../issues/README.md).
