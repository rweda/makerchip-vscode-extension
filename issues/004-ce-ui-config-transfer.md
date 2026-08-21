# 004: Transfer programs/settings into the CE UI pane (in-place, no reload)

- Status: open
- Area: compiler-explorer (rweda fork) / parent-bridge.ts, editor/compiler panes; mono pane RPC
- Created: 2026-08-20

## Problem

We want to programmatically drive the **visible Compiler Explorer GUI pane** — load a program plus
settings (language, compiler, args, source) into the live CE UI so a user can watch/explore/demo the
compilation — triggered over the pane RPC channel (the `runOnWarpV`-style method), **without a full
pane reload** (which destroys GoldenLayout state and any other panes).

This is **deferred**. The headless CE-API path (see issue 005) covers compile-for-result and testing
without any CE pane. This UI-transfer path is only needed when we specifically want the CE GUI itself
to update, and is worth doing later once the environment has user momentum.

## Findings (what the exploration established)

**Pane RPC plumbing.** The pane→IDE protocol is documented in
`mono/doc-src/plugin/Third_Party_Pane_API.md`. Host→pane calls arrive as
`{v:1, kind:'rpc-call', id, method, args}` and the pane must reply
`{v:1, kind:'rpc-call-result'|'rpc-call-error', ...}`. `parent-bridge.ts` currently handles only
`rpc-result`/`rpc-error`/`theme` — it has **no `rpc-call` handler yet**, so no pane method can be
invoked. The method name `runOnWarpV` is already referenced from
`mono/ide-env/coffee/platform/IdePlugin.coffee` (`ide.api.callPane("Compiler Explorer+2", "runOnWarpV", [])`).
Adding a `_rpcServed` map + `serve(method, fn)` helper (per the doc's reference client) is unambiguous.

**The reload problem.** CE applies language/compiler/options/source by serialising GoldenLayout state
into `window.location.hash`; a `hashchange` triggers a full pane reload
(`compiler-explorer/static/main.ts` ~L597). `parent-bridge.ts`'s `applyInitialStateFromParams()` uses
exactly this — which is fine **at pane open** (nothing to preserve yet) but unusable per-call because
it destroys layout and the in-memory RPC reply promise.

**In-place levers that already exist (no reload, no CE-core change).** `parent-bridge.ts` already
emits on CE's event bus, so it can drive:

| Setting | Bus event | Effect |
|---|---|---|
| source | `emit('newSource', editorId, source)` | `editor.onNewSource` → `setSource` → auto-recompile (compileOnChange default) |
| compiler args | `emit('compilerFlagsChange', compilerPaneId, flags)` | `compiler.onCompilerFlagsChange` → `onOptionsChange` → `compile()` |
| force compile | `emit('requestCompilation', editorId, treeId)` | `compiler.onRequestCompilation` → `compile()` |

So **source + args + run is already fully in-place** — the common demo loop needs no CE-core change.

**Levers that need a small CE-core addition (each = 1 event-map entry + 1 delegating handler):**

- **compiler selection** — `compiler.onCompilerChange(id)` exists but has no inbound bus event. Add
  e.g. `selectCompiler(compilerPaneId, compilerId)` guarded on `id === this.id`. Clean.
- **language** — `editor.changeLanguage(lang)` is public but has no bus event, **and switching
  language loads default code**: `onLanguageChange` (editor.ts ~L1875) calls `updateEditorCode()`
  (~L1937) → `setSource(editorSourceByLang[lang] || languages[lang].example)`, then forces a
  recompile. Side-steps, cleanest first:
  1. Pre-seed `editorSourceByLang[lang] = ourCode` **before** `changeLanguage` → our code loads, one
     compile, no example flash. (`editorSourceByLang` is private → needs a helper/event.)
  2. Set `waitingForLanguage = true` before `changeLanguage`, then `setSource` (skips example-load).
  3. `changeLanguage` then `setSource` — public-only but causes an example flash + wasted compile.
  Cleanest mechanism = one combined event `setEditorLanguageAndSource(editorId, lang, source)` that
  pre-seeds then switches (one load, one compile, right code, no flash). The global setting
  `keepSourcesOnLangChange` also disables example-loading, but it's global, not per-call.

**Hub has no compiler registry.** `hub` exposes `editors` / `getEditorById` but no public compilers
list (`compiler-explorer/static/hub.ts`), so reaching a compiler pane instance requires the bus
events above (or brittle GoldenLayout traversal).

**Return value.** A `runOnWarpV(config)` could apply config in-place, `await` the next `compileResult`
for the target compiler pane, emit `sourceAsm` with `build:true`, and return the CE compile outcome
`{code, entry, compilerId, compilerName, asmLineCount, stderr}`.

## Recommendation / phasing (when picked up)

- **Phase 1 (no CE-core changes):** add the `rpc-call` handler + `serve()` to `parent-bridge.ts` and a
  `runOnWarpV({source?, options?})` that applies source/args in-place and returns the outcome. Keep
  language/compiler set via the existing `params.ce` at pane open.
- **Phase 2 (2 small core edits):** add `selectCompiler` and `setEditorLanguageAndSource` events
  (wired to existing `onCompilerChange` / `changeLanguage`, with the example-load pre-seed) so
  `runOnWarpV` can switch compiler/language per-call without reopening.

## Notes

- Shared transforms extracted for the headless path (issue 005) — `toAsmRows`, `detectEntry`,
  `SourceAsmPayload` — are reusable here for building the emitted `sourceAsm`.
- Deployed CE runs the built bundle: any `parent-bridge.ts` change needs a rebuild+redeploy
  (`make prebuild` via `ce-update`) to take effect on `ce.makerchip.com`.
- `parent-bridge.ts` has uncommitted edits from prior work — don't clobber.
