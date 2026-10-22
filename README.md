# Makerchip VS Code Extension — Monorepo

This is an **npm workspaces monorepo** containing three published/publishable packages:

| Package | npm / VS Code id | Purpose |
|---------|-----------------|---------|
| `packages/tlv-grammar` | `@rweda/tlv-grammar` | TL-Verilog TextMate grammar and language configuration. Framework-neutral — reused by VS Code, Monaco, Shiki, and GitHub Linguist. No runtime code. |
| `packages/tlv-extension` | `RedwoodEDA.tl-verilog` | **TL-Verilog language extension**: `.tlv`/`.TLV` registration, grammar, snippets, semantic tokens, hovers, and (desktop-only) module instantiation. Grammar files are **copied from `tlv-grammar` at build time** — edit only in `tlv-grammar/`. |
| `packages/makerchip-extension` | `RedwoodEDA.makerchip` | **Makerchip IDE integration**: server-connected webview (compile/simulate, diagram, waveform, Nav-TLV, VIZ), GitHub Copilot LM tools, `@makerchip` chat participant, local compile cache. |

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

`makerchip` declares a hard `extensionDependencies` on `RedwoodEDA.tl-verilog`. VS Code
auto-installs `tl-verilog` alongside Makerchip and won't activate Makerchip without it.
`makerchip` contributes no language definition or grammar itself — it only references the
`tlverilog` language id in `when` clauses.

The language layer is kept as a separate, independently installable extension so that
editor-only TL-Verilog (use model 3) remains viable without pulling in the Makerchip IDE.

Two consequences that shape every release:

- **`tl-verilog` does not consume `@rweda/tlv-grammar` from npm.** `copy-grammar.mjs`
  copies the grammar in from `../tlv-grammar` at build time, so a published extension
  carries a *snapshot*. Publishing the grammar to npm changes nothing for VS Code users —
  a grammar fix reaches them only when `tl-verilog` is rebuilt and re-published. Grammar
  releases otherwise serve external consumers (Monaco, Shiki, Linguist).
- **`extensionDependencies` takes a bare extension id, with no version range.** There is
  no way to express "makerchip needs tl-verilog >= 2.1"; VS Code installs the latest. If
  makerchip starts relying on a new tl-verilog feature, publish `tl-verilog` first —
  nothing enforces it.

## Releasing

`.github/workflows/publish.yml` builds, version-checks and uploads artifacts for all three
packages, and publishes `tl-verilog` and `makerchip` to the Marketplace. npm (grammar) and
Open VSX publishing are still commented out behind `ENABLE PUBLISHING` markers. `ci.yml` is
the separate build-and-lint workflow and never publishes. Remaining pre-publish cleanup is tracked in [PUBLISHING.md](PUBLISHING.md).

### Publish order

| # | Package | Name | Registry |
|---|---------|------|----------|
| 1 | `packages/tlv-grammar` | `@rweda/tlv-grammar` | npm |
| 2 | `packages/tlv-extension` | `RedwoodEDA.tl-verilog` | Marketplace / Open VSX |
| 3 | `packages/makerchip-extension` | `RedwoodEDA.makerchip` | Marketplace / Open VSX |

Grammar first (it is the source of truth, and is not yet on npm), then `tl-verilog`, then
`makerchip` — which cannot install until `tl-verilog` is live. The grammar being absent
from npm does *not* block building `tl-verilog`; see Package coupling above.

Each extension's README is its Marketplace listing, which fetches images over HTTPS rather
than from the .vsix. vsce resolves relative links against `repository.url`, ignoring
`repository.directory`, so the `package` scripts pass `--baseContentUrl`/`--baseImagesUrl`
pointing at the package's directory at the release tag (`$GITHUB_REF_NAME` in CI; `main`
when packaging locally). Keep README links relative: the listing then shows the tagged
commit's images and docs, whatever later happens on `main`.

### Versioning policy

Each package versions independently — they are already out of lockstep (grammar 2.0.0,
tl-verilog 2.0.0, makerchip 0.0.1) and should stay that way. A makerchip fix has no
business bumping the grammar.

The policy is **bump by hand in the repo, publish on the tag**:

```bash
npm version minor --workspace tl-verilog   # bumps that manifest only
#   ...update the package's CHANGELOG.md...
git commit -am "tl-verilog 2.1.0"
git tag tlv-v2.1.0
git push --follow-tags
```

`npm version --workspace` deliberately does not commit or tag (unlike a single-package
repo), which is what lets us attach our own prefixed tag:

```
grammar-vX.Y.Z    -> packages/tlv-grammar
tlv-vX.Y.Z        -> packages/tlv-extension
makerchip-vX.Y.Z  -> packages/makerchip-extension
```

CI re-checks that the tag matches the manifest, so the classic manual-bump failure — tag
and `package.json` disagreeing — fails the job instead of publishing something
mislabelled. `workflow_dispatch` builds a chosen package without tagging. The publish
steps use `vsce publish --packagePath`, so what you install-test from the uploaded
artifact is exactly what reaches the Marketplace.

**Why not Changesets / Lerna / semantic-release.** Those earn their keep when many
packages publish to one registry and you want dependent bumps and changelogs generated.
Here there are three packages across two registries, and `vsce` is not something they
publish for. Revisit if the package count grows; the clean upgrade path is Changesets for
*versioning only*, still leaving the tag-triggered jobs to publish.

### Credentials

Both registries authenticate over OIDC, so `permissions: id-token: write` is declared at
the workflow level and there is no long-lived publish token.

- **Marketplace** — Azure Entra ID federated credential (`azure/login@v2` +
  `vsce publish --azure-credential`), not a `VSCE_PAT`. Needs `AZURE_CLIENT_ID`
  (an Entra ID app registration, which needs no Azure subscription) and
  `AZURE_TENANT_ID`. The credential trusts the `marketplace` GitHub environment that
  the publish jobs run in; the workflow's `azure-check` target verifies it and prints
  the identity to add to the `RedwoodEDA` publisher's members.
- **npm** — npm trusted publishing, matching the sibling repo
  `@rweda/makerchip-view-client`. No `NPM_TOKEN`. Configure at npmjs.com -> the package's
  Settings -> Trusted Publisher, pointing at this repo and
  `.github/workflows/publish.yml`.
- **Open VSX** (optional) — still PAT-based: `OVSX_PAT`.

Two traps already hit by `makerchip-view-client`, which publishes to the same npm account:

1. **npm version floor.** Trusted publishing needs npm >= 11.5.1, newer than the runner's
   bundled npm. view-client upgraded with `npm install -g npm@latest`, and that is how its
   v0.2.0 publish failed — npm 12 requires Node `^22.22.2 || ^24.15.0 || >=26.0.0`, the job
   pinned Node 20, and it died with `EBADENGINE` before reaching `npm publish`. The grammar
   job here uses Node 22 and pins `npm@^11`. Leave it pinned.
2. **The first publish probably cannot be automated.** A trusted publisher is configured on
   a package that already exists, and `@rweda/tlv-grammar` is not on npm yet. view-client's
   own 0.1.0 went out by hand. Expect to publish the grammar manually once, then wire up
   OIDC for later releases.

## Contributing

Build instructions, the `./launch` dev workflow, and the gotchas that bite
newcomers (and agents) live in [CONTRIBUTING.md](CONTRIBUTING.md).
