# 005: Headless CE-API compile path (no CE pane)

- Status: in-progress
- Area: CE compile via HTTP API; shared sourceAsm transforms; test/AI-driven use
- Created: 2026-08-20

## Goal

Compile a program through Compiler Explorer **without opening the CE GUI pane** — a headless HTTP
call to the CE API — for testing and AI-driven use. Return the compile outcome and, when feeding
WARP-V, deliver the result into a WARP-V pane and report the resulting host compile id. (The
visible-CE-UI variant is deferred: see issue 004.)

## How it works

- **CE API:** `POST <ceOrigin>/api/compiler/<compiler-id>/compile` (default origin
  `https://ce.makerchip.com`, dev `http://localhost:10240`; from mono
  `ide-env/coffee/platform/PWA_IDE.coffee`). `/api/*` is fully CORS-open, so it is callable from any
  browser origin or Node with no proxy. Body:
  `{source, lang, options:{userArguments, filters, compilerOptions:{}, libraries:[], tools:[]}}`,
  `Accept: application/json`. Response includes `code`, `asm[]`, `labelDefinitions` (drives
  `detectEntry`), `stderr`, etc. Defaults: compiler `rv32-cgcc1430`, lang `c`,
  `-O2 -march=rv32i -mabi=ilp32`, filters `directives,labels,commentOnly`.
- **Extension (`packages/makerchip-extension`):** `src/ceCompile.ts` — host-agnostic
  `compileOnCe(...)` → `{code, entry, compilerId, compilerName, lang, asm, asmText, stderr}`.
  `toAsmRows`/`detectEntry` are re-implemented locally (mirror
  `compiler-explorer/static/parent-bridge.ts`; see Remaining); best-effort `resolveCompilerName` via
  `GET /api/compilers/<lang>`. LM tool `makerchip_ce_compile` (`CeCompileTool`, registered in
  `makerchipTool.ts`, contributed in `package.json`).
- **WARP-V delivery (`deliverToWarpV:true`)** — the headless equivalent of CE's “Run on WARP-V”:
  - Ensure a WARP-V pane: reuse by mnemonic `warpvPane` (default `WARP-V`), else `openThirdPartyPane`
    a WARP-V iframe with `channel.rpc:true` and a `sourceAsm`/`theme` subscription.
  - Drive the build via host→pane RPC: `callIdeMethodWithResult('callPane', [target, 'build',
    [payload, waitForCompileId], paneTimeout], panelName, false, hostTimeout)`. The pane's registered
    `build(payload, waitForCompileId)` (WARP-V `PaneChannelClient.registerPaneMethod`) loads the
    delivered program, generates the TL-Verilog, and loads+compiles it in the HOST panel via the
    `loadCode` IDE method (whitelisted in `paneRpcAllowedIdeMethods`; mono `Session.getIDEMethods`).
    `loadCode` always returns `{changeGeneration, compileId}` and, when `waitForCompileId`, awaits the
    server-assigned compile id, which is relayed back through the RPC chain and reported for polling
    with `makerchip_wait_compile`. (The deprecated `setCode`/`loadProject` only return a
    change-generation and fire-and-forget the compile.)
  - `waitForCompileId` (default true at the tool level) makes the wait optional (Promises aren't
    serializable across the iframe): false = fire-and-forget, no id. Payload gating is `code === 0`
    (a null `entry` is valid; WARP-V uses the generated crt0 preamble). The mono `?warpv` demo
    backdoor is left unchanged.

## Remaining

- **Commit + deploy the cross-repo source changes (blocks prod use).** The handlers do not yet exist
  on deployed `warp-v.org`, so `deliverToWarpV` against the default (prod) `warpvUrl` opens a pane
  lacking `build`/`runProject`:
  - `mono_ce`: `Session.loadCode` (`Session.coffee`) + `loadCode` in `paneRpcAllowedIdeMethods`
    (`IDE.coffee`).
  - `warp-v/configurator`: `PaneChannelClient.js` (inbound host→pane RPC, `registerPaneMethod`,
    `postReady`), `App.js` (`build` pane method + batched delivery), `WarpVPageBase.js` (build
    effect → `callIde('loadCode', tlv, {waitForCompileId})`, resolves the compile id back).
- **Shared-helper refactor:** extract `toAsmRows`/`detectEntry`/`SourceAsmPayload` out of
  `compiler-explorer/static/parent-bridge.ts` into a plain shared module so headless and the pane
  path share one contract (currently a deliberate local duplication).
- **Visible CE-UI in-place transfer** (driving the actual CE GUI) — deferred; see issue 004.

## Notes

- Zero CE-server changes, zero proxy, zero CE-pane coupling.
- **Testing dev WARP-V (mixed-content constraint):** the clone-mode IDE is framed over an HTTPS
  cloudflare tunnel (webview CSP `frame-src https:`), so it cannot frame `http://localhost:3009` (the
  WARP-V dev server) — mixed content blocks it and the pane never signals `ready`, so `callPane`
  times out. To test dev WARP-V, expose 3009 over HTTPS:
  `cloudflared tunnel --url http://localhost:3009 --http-host-header localhost:3009` (host-header
  rewrite avoids react-scripts' "Invalid Host header"), pass that URL as `warpvUrl`, and use a fresh
  `warpvPane` mnemonic (the tool reuses panes by mnemonic, including broken ones). Deployed
  `warp-v.org` frames fine over HTTPS and needs no tunnel — only the code deploy above.
