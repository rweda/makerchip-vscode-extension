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

- **Server (mono `sandhost/sandpiper-compiler`):** the results wildcard route (`Routing.coffee`)
  already serves any file in the compile directory, includes included. Add the resolved include set
  to the `sp-exitstatus` artifacts manifest (`SandPiperCompiler.coffee` `modelArtifacts`, emitted by
  `CompileSocket.coffee`) so clients can enumerate them.
- **Extension:** consume that manifest (the `sp-exitstatus` listener in `webview.ts` currently
  ignores its `artifacts` argument), merge announced includes into `metadata.intermediateFiles`
  (with fetch URLs + a description), and pull them under `fetchIntermediateFiles` like the other
  intermediates.

## Notes

- Keep the top-level intermediates working without this — includes are additive.
