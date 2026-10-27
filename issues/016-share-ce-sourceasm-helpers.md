# 016: Share CE `sourceAsm` helpers between the CE pane and headless compile

- Status: open
- Area: compiler-explorer (rweda fork) `static/parent-bridge.ts`; extension `ceCompile.ts`
- Created: 2026-10-27

The CE pane path (`parent-bridge.ts`) and the headless path (`makerchip_ce_compile`, `ceCompile.ts`)
each carry their own copy of `toAsmRows`, `detectEntry` (+ `ENTRY_CANDIDATES`) and the `sourceAsm`
payload type (`SourceAsmPayload` / `WarpVSourceAsm`). WARP-V consumes the payload from both, so the
copies are one contract. They have already drifted once: Fortran's entry was fixed to `main` only
in the extension, so the CE pane emitted the void `MAIN__`.

## Remaining

- Extract the helpers and payload type into one plain module both builds consume (CE browser bundle
  and the Node extension host are separate repos/builds, so pick a vehicle: published package,
  vendored copy with a sync check, or WARP-V owning entry detection).
- Until then, change both copies together.
