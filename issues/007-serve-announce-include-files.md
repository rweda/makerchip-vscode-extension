# 007: Serve and announce compile include files

- Status: open
- Area: mono compile results route + compile response; extension intermediate-file surfacing
- Created: 2026-08-29

## Goal

Make a compile's *included* input files discoverable and fetchable alongside the top-level
intermediates (`<base>.m4.pre`, `<base>.m4`, `<base>.sv`, `<base>_gen.sv`), which the extension
already announces in `metadata.json` (`intermediateFiles`) and can pull with
`fetchIntermediateFiles`. See `packages/makerchip-extension/src/compileCache.ts`.

A compile directory can also hold resolved includes that are currently **not served** and **not
announced**:

- `m4_include_url_file.1`, `m4_include_url_file.2`, … — files pulled in via `m4_include_url(...)`.
- `sv_inc_url/*` — SystemVerilog includes pulled in via URL.

The set (names/count) is only known after the compile runs, so the top-level `intermediateFiles`
map (derived from the top-file base name) can't enumerate them a priori.

## Remaining work

- **Server (`mono_example_videos/sandhost/sandpiper-compiler`):** allow the results wildcard route
  to serve `m4_include_url_file.*` and `sv_inc_url/*` (confirm they aren't excluded), and add the
  resolved include set to the compile response/events so clients can enumerate them. This likely
  means extending the `newcompile`/completion payload with the include listing.
- **Extension:** on `compileStart`/completion, merge any announced includes into
  `metadata.intermediateFiles` (with fetch URLs + a description), and pull them under
  `fetchIntermediateFiles` like the other intermediates.

## Notes

- No `faas-mono` changes required; this is the active `mono_example_videos` server plus the
  extension.
- Keep the top-level intermediates working without this — includes are additive.
