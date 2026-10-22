# Makerchip VS Code Extension — Development Guide

See [`README.md`](../README.md) for repo structure, use models, coupling rationale, and
development workflow, and [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the public build/PR flow.
This repo is public; Redwood EDA also co-develops it against a **private** `mono` server clone,
covered under [Internal Development](#internal-development).

Key constraints to preserve when making changes:

- **Preserve all three use models** (Desktop Makerchip, Web Makerchip, Editor-only TL-Verilog).
- **Keep `languageFeatures.ts` web-safe** — no `fs`, `path`, `axios`, or any Node-only API.
- **Do not fold language support into `makerchip-extension`** — the language layer must remain
  independently installable as `tlverilog` so editor-only use is viable without Makerchip.
- **Grammar edits go in `tlv-grammar/` only** — `tlv-extension/syntaxes/tlverilog.tmLanguage` and
  `tlv-extension/language-configuration.json` are build artifacts copied by `scripts/copy-grammar.mjs`
  and are gitignored. Never edit them in `tlv-extension/`.
- **Issues are a live backlog, not a changelog** — `issues/NNN-slug.md` files track *current status
  and remaining work only*. As work completes, remove it from the issue and fold durable outcomes
  into code/docs/READMEs; rely on Git history for how things evolved (no dated "vN/shipped/verified"
  narration). See [`issues/README.md`](../issues/README.md).
- **LM tool docs — describe the tool capabilities in `modelDescription`, arguments details in `inputSchema`:** the model
  receives both, so don't restate per-argument detail in `modelDescription` (redundant tokens, two
  places to keep in sync). Keep `modelDescription` to what the tool does, when to use it, and
  genuinely cross-argument behavior (how options interact, ordering, gating); document each argument
  once in its `inputSchema` property `description`. The mirror TypeScript input interface (e.g.
  `MakerchipToolInput`) is the source the property descriptions track.

## Internal Development

Redwood-internal. This repo is public, but Redwood EDA co-develops it against a **private**
`mono` server clone. The full workflow — `./launch <clone>`, Cloudflare tunnels, per-clone VS
Code profiles, `bin/reap` — lives in [`DEVELOPMENT-INTERNAL.md`](../DEVELOPMENT-INTERNAL.md);
keep it out of public-facing docs.

- **`./launch` selects the server you develop against:** bare `./launch` / `./launch <url>`
  target a *deployed* server (the public flow). `./launch <mono-clone>` targets a local `mono`
  clone — the unit of coupling (clone ↔ port ↔ tunnel ↔ workspace ↔ profile) — documented in
  [`DEVELOPMENT-INTERNAL.md`](../DEVELOPMENT-INTERNAL.md).
- **Co-dev setup:** `./launch` and "Run Extension" (F5) load both extensions from source via
  two `--extensionDevelopmentPath` args. The `watch: all` task builds both. Reload the
  Extension Development Host window after `tsc` finishes to pick up changes.

