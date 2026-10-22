# Pre-publish cleanup — TODO

**Temporary.** This is the punch list standing between us and the first real
release. Delete this file once each package has shipped once.

How releases actually work — publish order, versioning policy, tag conventions,
credentials — lives in [README.md](README.md#releasing). Build gotchas live in
[CONTRIBUTING.md](CONTRIBUTING.md) and the per-package contributor guides.
Nothing durable belongs here.

## Remaining before the first publish

- Confirm the `redwood-eda` publisher and its Entra ID federated credential.
- Enable the publish steps in `.github/workflows/publish.yml` (the
  `ENABLE PUBLISHING` markers) and publish in order: grammar, `tl-verilog`,
  `makerchip`.
- Set the `CHANGELOG.md` dates (both extensions say "unreleased").
- Settle `engines.vscode` against the README: the manifest says `^1.95.0`, the
  README says 1.110. Raising `engines` blocks older VS Code and possibly
  Cursor, whose VS Code base lags; lowering the README is only safe if the
  extension works there.
- After publishing, install `makerchip` from the Marketplace in a clean
  profile and check that `tl-verilog` comes with it. (A `.vsix` install does
  not pull dependencies: makerchip installs alone but won't activate.)

Done: version (`0.0.1`, pre-release via `"preview": true`), changelog content,
manifest description/homepage/bugs/keywords, `npm test` (uses the in-repo
`tl-verilog`), install test of both `.vsix` files, and the Terms (deployed to
makerchip.com, serving `/terms/updated`).

## Decisions to record

- Dev-only surface is public: the `makerchip.devServerUrls` setting and the
  `serverUrl` parameter of `makerchip_compile` (the README omits both). Hide
  them, or accept them as documented developer hooks.
- The Terms and Privacy Policy get legal review in mono's next version. The
  extension asks users again when either `**Last updated:**` date moves, so
  bump the dates only for changes users should re-accept.

## `tl-verilog`

- [ ] **axios.** It is a declared runtime dependency, but its only importers
      (`src/experimental/sandpiperClient.ts`, `src/experimental/sandpiperCompile.ts`)
      are commented out of the import graph in `src/experimental/index.ts`.
      With `--no-dependencies`, axios is *not* shipped in the .vsix. That is
      safe today, but re-enabling the SandPiper compile button would ship an
      extension that crashes on load. Either drop axios, or bundle the desktop
      entry with esbuild the way `browser` already is.
- [ ] The `tlv-grammar` README's "not on npm yet" banner should be dropped once
      it ships.

## Listing polish

- [ ] More screenshots. makerchip has one; `tl-verilog` has none. Ideas: an
      agent highlighting signals, and an animated GIF of a VIZ or Live Doc (e.g.
      the MYTH slides) made with `makerchip_capture_video`. Put them in
      `packages/<ext>/images/` and reference them relatively; the `package`
      scripts' `--baseImagesUrl` points them at the release tag on GitHub, so
      they must be in the tagged commit. PNG or GIF, ~1200-1600px wide, under
      ~1MB.
