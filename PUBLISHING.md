# Pre-publish cleanup — TODO

**Temporary.** This is the punch list standing between us and the first real
release. Delete this file once each package has shipped once.

How releases actually work — publish order, versioning policy, tag conventions,
credentials — lives in [README.md](README.md#releasing). Build gotchas live in
[CONTRIBUTING.md](CONTRIBUTING.md) and the per-package contributor guides.
Nothing durable belongs here.

Not all of the below blocks a release. The minimum set before the first real
publish:

- `tl-verilog`: fix `repository.url` (currently points at the old repo).
- `makerchip`: add an `icon`, settle the version (still `0.0.1`), and write a
  real `CHANGELOG.md`.
- Confirm the `redwood-eda` publisher and its Entra ID federated credential.
- Install-test both .vsix artifacts, makerchip last.

The rest is polish or a decision to record.

## `tl-verilog`

- [ ] **axios.** It is a declared runtime dependency, but its only importers
      (`src/experimental/sandpiperClient.ts`, `src/experimental/sandpiperCompile.ts`)
      are commented out of the import graph in `src/experimental/index.ts`.
      With `--no-dependencies`, axios is *not* shipped in the .vsix. That is
      safe today, but re-enabling the SandPiper compile button would ship an
      extension that crashes on load. Either drop axios, or bundle the desktop
      entry with esbuild the way `browser` already is.

## `makerchip`

- [ ] `CHANGELOG.md` is drafted but every entry is dated "unreleased"; set real
      dates at release time. Same for `tl-verilog`.

## Documentation

Both extension READMEs are rendered verbatim as the **Marketplace listing page**,
so they are a publishing blocker, not just housekeeping.

- [ ] The `tlv-grammar` README's "not on npm yet" banner should be dropped once
      it ships.
- [ ] **Screenshots.** Neither listing has any; Marketplace pages lean heavily
      on them. Requirements, verified by unpacking a .vsix:

      - **Format/size:** PNG (animated GIF also renders). Aim for ~1200-1600px
        wide, under ~1MB each. No fixed limit, but the page scales them down.
      - **Where to put them:** `packages/<ext>/images/`, alongside `icon.png`.
      - **How to reference them — this is the trap.** Marketplace does *not*
        serve images from the .vsix; it fetches them over HTTPS. vsce rewrites
        relative image paths against `repository.url` and **ignores the
        `directory` field**, so `![x](images/shot.png)` in a package README
        becomes `.../raw/HEAD/images/shot.png` — a path that does not exist in
        this monorepo, and a broken image on the listing.

        So use an absolute URL in the README:

        ```
        ![Compiling a design](https://github.com/rweda/makerchip-vscode-extension/raw/main/packages/makerchip-extension/images/compile.png)
        ```

      - The images must be **committed and pushed to `main`** before publishing,
        or the listing shows broken images even though the .vsix is fine.
      - The icon is separate and *is* shipped in the .vsix:
        `images/icon.png`, 128x128 PNG, referenced by the `icon` manifest field.

## Both extensions

- [ ] Do a real install test from the built .vsix artifacts before enabling
      anything, especially the makerchip -> tl-verilog dependency.
